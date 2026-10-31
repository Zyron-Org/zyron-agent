import { LlmProvider } from './provider';
import { GeminiProvider } from './gemini.provider';
import { MetaProvider } from './meta.provider';

export type LlmProviderName = 'meta' | 'gemini';

/**
 * Selects the prover's LLM from the environment.
 *   LLM_PROVIDER=meta|gemini  (explicit)
 *   otherwise: meta if MODEL_API_KEY is set, else gemini (pre-existing behaviour).
 */
export function resolveProviderName(env: NodeJS.ProcessEnv = process.env): LlmProviderName {
  const explicit = (env.LLM_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'meta' || explicit === 'gemini') return explicit;
  if (explicit) throw new Error(`Unsupported LLM_PROVIDER "${env.LLM_PROVIDER}" (expected "meta" or "gemini")`);
  return env.MODEL_API_KEY ? 'meta' : 'gemini';
}

export function createLlmProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const name = resolveProviderName(env);
  if (name === 'meta') {
    return new MetaProvider({
      apiKey: env.MODEL_API_KEY,
      model: env.META_MODEL,
      baseUrl: env.META_API_BASE_URL,
    });
  }
  return new GeminiProvider();
}
