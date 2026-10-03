import axios from 'axios';
import { LlmProvider } from './provider';
import { LlmMessage, ToolDefinition, LlmResponse, ToolCall, LlmProviderOptions } from './types';

export class GeminiProvider implements LlmProvider {
  readonly providerName = 'gemini';
  readonly modelName: string;
  private readonly apiKey: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(options: LlmProviderOptions = {}) {
    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY || '';
    this.modelName = options.model || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
    this.temperature = options.temperature ?? 0.2;
    this.maxTokens = options.maxTokens ?? 8192;
    this.timeoutMs = options.timeoutMs ?? 45000;

    if (!this.apiKey) {
      console.warn('[GeminiProvider] Warning: GEMINI_API_KEY is not set.');
    }
  }

  async chat(messages: LlmMessage[], tools?: ToolDefinition[]): Promise<LlmResponse> {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY is required to call GeminiProvider.');
    }

    const { contents, systemInstruction } = this.formatMessages(messages);
    const geminiTools = this.formatTools(tools);

    const payload: Record<string, any> = {
      contents,
      generationConfig: {
        temperature: this.temperature,
        maxOutputTokens: this.maxTokens,
      },
    };

    if (systemInstruction) {
      payload.systemInstruction = systemInstruction;
    }

    if (geminiTools && geminiTools.length > 0) {
      payload.tools = geminiTools;
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:generateContent?key=${this.apiKey}`;

    let attempts = 0;
    const maxAttempts = 4;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        const res = await axios.post(url, payload, {
          timeout: this.timeoutMs,
          headers: { 'Content-Type': 'application/json' },
        });

        const candidate = res.data?.candidates?.[0];
        if (!candidate) {
          throw new Error('Gemini API returned no candidates');
        }

        const parts = candidate.content?.parts || [];
        let textContent = '';
        const toolCalls: ToolCall[] = [];

        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          if (part.text) {
            textContent += part.text;
          }
          if (part.functionCall) {
            toolCalls.push({
              id: part.functionCall.id || `call_${Date.now()}_${i}`,
              name: part.functionCall.name,
              arguments: part.functionCall.args || {},
              thoughtSignature: part.thoughtSignature || part.functionCall.thought_signature || part.functionCall.thoughtSignature,
              rawPart: part,
            });
          }
        }

        const usageMetadata = res.data?.usageMetadata;
        return {
          content: textContent,
          toolCalls,
          rawParts: parts,
          finishReason: candidate.finishReason || 'STOP',
          usage: usageMetadata
            ? {
                promptTokens: usageMetadata.promptTokenCount || 0,
                completionTokens: usageMetadata.candidatesTokenCount || 0,
                totalTokens: usageMetadata.totalTokenCount || 0,
              }
            : undefined,
        };
      } catch (err: any) {
        const status = err.response?.status;
        const errorData = err.response?.data?.error;
        const msg = errorData?.message || err.message;

        if ((status === 429 || status === 503 || status === 502 || status === 500) && attempts < maxAttempts) {
          const match = msg.match(/retry in ([\d\.]+)s/i);
          const waitSec = match ? Math.min(Math.ceil(parseFloat(match[1])), 45) : attempts * 5;
          console.warn(`[GeminiProvider] Transient error / rate limit (${status}). Retrying in ${waitSec}s (attempt ${attempts}/${maxAttempts})...`);
          await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
          continue;
        }

        const httpStatus = status ? `HTTP ${status}` : 'Request Error';
        throw new Error(`[GeminiProvider] ${httpStatus}: ${msg}`);
      }
    }

    throw new Error('[GeminiProvider] Exceeded maximum retry attempts');
  }

  private formatMessages(messages: LlmMessage[]) {
    let systemInstruction: any = undefined;
    const contents: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = {
          parts: [{ text: msg.content || '' }],
        };
        continue;
      }

      if (msg.role === 'user') {
        const parts: any[] = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        contents.push({ role: 'user', parts });
        continue;
      }

      if (msg.role === 'assistant') {
        if (msg.rawParts && msg.rawParts.length > 0) {
          contents.push({ role: 'model', parts: msg.rawParts });
          continue;
        }

        const parts: any[] = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            if (tc.rawPart) {
              parts.push(tc.rawPart);
            } else {
              const fc: any = {
                name: tc.name,
                args: tc.arguments,
              };
              const partObj: any = { functionCall: fc };
              if (tc.thoughtSignature) {
                partObj.thoughtSignature = tc.thoughtSignature;
              }
              parts.push(partObj);
            }
          }
        }
        contents.push({ role: 'model', parts });
        continue;
      }

      if (msg.role === 'tool' && msg.toolResults) {
        const parts: any[] = [];
        for (const res of msg.toolResults) {
          parts.push({
            functionResponse: {
              name: res.name,
              response: {
                output: res.output,
                isError: !!res.isError,
              },
            },
          });
        }
        contents.push({ role: 'user', parts });
        continue;
      }
    }

    return { contents, systemInstruction };
  }

  private formatTools(tools?: ToolDefinition[]): any[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    const functionDeclarations = tools.map((t) => {
      const convertedProps: Record<string, any> = {};
      const required = t.parameters.required || [];

      for (const [key, prop] of Object.entries(t.parameters.properties || {})) {
        convertedProps[key] = {
          type: prop.type.toUpperCase(),
          description: prop.description,
          ...(prop.enum ? { enum: prop.enum } : {}),
          ...(prop.items ? { items: { type: prop.items.type.toUpperCase(), description: prop.items.description } } : {}),
        };
      }

      return {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'OBJECT',
          properties: convertedProps,
          required,
        },
      };
    });

    return [{ functionDeclarations }];
  }
}
