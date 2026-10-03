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

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
      const response = await axios.post(
        url,
        {
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2048,
          },
        },
        { timeout: 20000 },
      );

      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        const match = text.match(/```solidity([\s\S]*?)```/) || text.match(/```([\s\S]*?)```/);
        if (match && match[1]) {
          return match[1].trim();
        }
        if (text.includes('contract ExploitTest')) {
          return text.trim();
        }
        return text.trim();
      }

      throw new Error('Gemini API returned an empty response with no exploit test candidates.');
    } catch (err: any) {
      const errorData = err.response?.data?.error;
      const status = err.response?.status ? `HTTP ${err.response.status}` : 'Network Error';
      const detail = errorData?.message || err.message;
      const fullError = `Gemini API call failed (${status}: ${detail})`;
      console.error(`[PoC Synthesizer] ${fullError}`);
      throw new Error(fullError);
    }

  }
}
