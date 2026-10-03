import axios from 'axios';
import { GEMINI_API_KEY, GEMINI_MODEL } from '../config/env';
import { FindingToProve } from '../types';
import { buildPoCSynthesisPrompt } from './poc-prompt';

export class PoCSynthesizer {
  /**
   * Synthesizes an executable Solidity Proof-of-Concept exploit test using Google Gemini.
   */
  static async synthesizePoC(
    contractFileName: string,
    sourceCode: string,
    finding: FindingToProve,
  ): Promise<string> {
    const prompt = buildPoCSynthesisPrompt(contractFileName, sourceCode, finding);

    if (!GEMINI_API_KEY || GEMINI_API_KEY.length <= 5) {
      throw new Error(
        'Gemini API key is missing or invalid in zyron-agent environment (GEMINI_API_KEY). Please configure a valid Google Gemini API key.',
      );
    }

    const modelsToTry = [
      GEMINI_MODEL,
      'gemini-3.5-flash',
      'gemini-3.6-flash',
      'gemini-flash-latest',
    ].filter((v, i, a) => a.indexOf(v) === i && !!v);

    let lastError: any = null;

    for (const model of modelsToTry) {
      try {
        console.log(`[PoC Synthesizer] Requesting synthesis using ${model}...`);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
        const response = await axios.post(
          url,
          {
            contents: [
              {
                role: 'user',
                parts: [{ text: prompt }],
              },
            ],
            safetySettings: [
              { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
              { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
              { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
              { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            ],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 8192,
              thinkingConfig: {
                thinkingBudget: 0,
              },
            },
          },
          { timeout: 35000 },
        );

        const candidate = response.data?.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        const text = parts.map((p: any) => p.text).filter(Boolean).join('');

        if (text) {
          const match = text.match(/```(?:solidity)?([\s\S]*?)```/i);
          if (match && match[1] && match[1].includes('contract')) {
            console.log(`[PoC Synthesizer] Successfully synthesized PoC using ${model}`);
            return match[1].trim();
          }
          if (text.includes('contract ExploitTest') || (text.includes('contract ') && text.includes('test'))) {
            console.log(`[PoC Synthesizer] Successfully synthesized PoC using ${model}`);
            return text.trim();
          }
          console.warn(`[PoC Synthesizer] Model ${model} returned non-code response. Trying next model...`);
        } else {
          console.warn(`[PoC Synthesizer] Model ${model} returned empty parts. Trying next model...`);
        }
      } catch (err: any) {
        lastError = err;
        const status = err.response?.status ? `HTTP ${err.response.status}` : err.message;
        console.warn(`[PoC Synthesizer] Model ${model} call failed (${status}). Trying next model...`);
      }
    }

    const errorData = lastError?.response?.data?.error;
    const status = lastError?.response?.status ? `HTTP ${lastError.response.status}` : 'API Error';
    const detail = errorData?.message || lastError?.message || 'Models returned empty response or refused code synthesis.';
    const fullError = `Gemini API call failed (${status}: ${detail})`;
    console.error(`[PoC Synthesizer] ${fullError}`);
    throw new Error(fullError);

  }
}
