import { LlmChatOptions, LlmProvider } from './provider';
import { LlmMessage, LlmResponse, ToolCall, ToolDefinition } from './types';

/**
 * Meta Model API provider (OpenAI-compatible Chat Completions).
 *
 *   POST {baseUrl}/chat/completions
 *   Authorization: Bearer $MODEL_API_KEY
 *
 * Defaults: baseUrl https://api.meta.ai/v1, model muse-spark-1.3.
 * The payload is intentionally minimal (model, messages, tools, tool_choice):
 * reasoning models may reject optional sampling params with HTTP 400.
 * No "contributor"/data-sharing flags are ever sent.
 */

export type MetaErrorCode =
  | 'CONFIG'
  | 'AUTH'
  | 'MODEL_UNAVAILABLE'
  | 'BAD_REQUEST'
  | 'RATE_LIMIT'
  | 'SERVER'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'NETWORK'
  | 'INVALID_RESPONSE';

export class MetaApiError extends Error {
  constructor(
    readonly code: MetaErrorCode,
    message: string,
    readonly httpStatus?: number,
    readonly retryable = false,
  ) {
    super(`[MetaProvider] ${code}${httpStatus ? ` (HTTP ${httpStatus})` : ''}: ${message}`);
    this.name = 'MetaApiError';
  }
}

export interface HttpResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type HttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<HttpResponseLike>;

export interface MetaProviderLogEvent {
  event: 'request' | 'response' | 'retry' | 'error';
  model: string;
  attempt: number;
  status?: number;
  code?: MetaErrorCode;
  delayMs?: number;
  durationMs?: number;
  toolCalls?: number;
  usage?: LlmResponse['usage'];
}

export interface MetaProviderOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  temperature?: number;
  maxCompletionTokens?: number;
  fetchImpl?: HttpFetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  logger?: (e: MetaProviderLogEvent) => void;
}

const MAX_BACKOFF_MS = 20_000;
const MAX_RETRY_AFTER_MS = 30_000;

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new MetaApiError('ABORTED', 'Request cancelled'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new MetaApiError('ABORTED', 'Request cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class MetaProvider implements LlmProvider {
  readonly providerName = 'meta';
  readonly modelName: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly temperature?: number;
  private readonly maxCompletionTokens?: number;
  private readonly fetchImpl: HttpFetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly logger: (e: MetaProviderLogEvent) => void;

  constructor(options: MetaProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.MODEL_API_KEY ?? '';
    this.modelName = options.model || process.env.META_MODEL || 'muse-spark-1.3';
    this.baseUrl = (options.baseUrl || process.env.META_API_BASE_URL || 'https://api.meta.ai/v1').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? parseInt(process.env.META_TIMEOUT_MS || '90000', 10);
    this.maxRetries = options.maxRetries ?? parseInt(process.env.META_MAX_RETRIES || '3', 10);
    this.temperature = options.temperature ?? (process.env.META_TEMPERATURE ? Number(process.env.META_TEMPERATURE) : undefined);
    this.maxCompletionTokens =
      options.maxCompletionTokens ?? (process.env.META_MAX_COMPLETION_TOKENS ? parseInt(process.env.META_MAX_COMPLETION_TOKENS, 10) : undefined);
    this.fetchImpl = options.fetchImpl || (globalThis.fetch as unknown as HttpFetch);
    this.sleep = options.sleep || abortableSleep;
    this.logger =
      options.logger ||
      ((e) => {
        // Operational log only: never includes the API key, prompts, or tool payloads.
        const fn = e.event === 'error' ? console.warn : console.log;
        fn(`[MetaProvider] ${JSON.stringify(e)}`);
      });

    if (!/^https:\/\//.test(this.baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(this.baseUrl)) {
      throw new MetaApiError('CONFIG', 'META_API_BASE_URL must use https');
    }
  }

  async chat(messages: LlmMessage[], tools?: ToolDefinition[], options: LlmChatOptions = {}): Promise<LlmResponse> {
    if (!this.apiKey) {
      throw new MetaApiError('CONFIG', 'MODEL_API_KEY is not configured on the server');
    }

    const body: Record<string, unknown> = {
      model: this.modelName,
      messages: this.formatMessages(messages),
    };
    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }
    if (this.temperature !== undefined) body.temperature = this.temperature;
    if (this.maxCompletionTokens !== undefined) body.max_completion_tokens = this.maxCompletionTokens;

    const serialized = JSON.stringify(body);
    let attempt = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt++;
      if (options.signal?.aborted) throw new MetaApiError('ABORTED', 'Request cancelled');

      const started = Date.now();
      this.logger({ event: 'request', model: this.modelName, attempt });

      let err: MetaApiError;
      let retryAfterMs: number | undefined;
      try {
        const res = await this.send(serialized, options.signal);
        const text = await res.text();

        if (res.status >= 200 && res.status < 300) {
          const parsed = this.parseResponse(text);
          this.logger({
            event: 'response',
            model: this.modelName,
            attempt,
            status: res.status,
            durationMs: Date.now() - started,
            toolCalls: parsed.toolCalls.length,
            usage: parsed.usage,
          });
          return parsed;
        }

        err = this.classifyHttpError(res.status, text);
        const ra = res.headers.get('retry-after');
        if (ra && !Number.isNaN(Number(ra))) retryAfterMs = Math.min(Number(ra) * 1000, MAX_RETRY_AFTER_MS);
      } catch (e: any) {
        if (e instanceof MetaApiError) {
          err = e;
        } else if (options.signal?.aborted) {
          err = new MetaApiError('ABORTED', 'Request cancelled');
        } else if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
          err = new MetaApiError('TIMEOUT', `No response within ${this.timeoutMs}ms`, undefined, true);
        } else {
          err = new MetaApiError('NETWORK', e?.message || 'Network error', undefined, true);
        }
      }

      if (!err.retryable || attempt > this.maxRetries) {
        this.logger({ event: 'error', model: this.modelName, attempt, status: err.httpStatus, code: err.code });
        throw err;
      }

      const backoff = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      const delayMs = retryAfterMs ?? backoff + Math.floor(Math.random() * 250);
      this.logger({ event: 'retry', model: this.modelName, attempt, status: err.httpStatus, code: err.code, delayMs });
      await this.sleep(delayMs, options.signal);
    }
  }

  private async send(body: string, external?: AbortSignal): Promise<HttpResponseLike> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    external?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal: controller.signal,
      });
    } catch (e: any) {
      if (external?.aborted) throw new MetaApiError('ABORTED', 'Request cancelled');
      if (timedOut) throw new MetaApiError('TIMEOUT', `No response within ${this.timeoutMs}ms`, undefined, true);
      throw e;
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    }
  }

  private classifyHttpError(status: number, text: string): MetaApiError {
    let msg = text.slice(0, 300);
    let apiCode = '';
    try {
      const j = JSON.parse(text);
      msg = String(j?.error?.message || j?.message || msg).slice(0, 300);
      apiCode = String(j?.error?.code || j?.error?.type || '');
    } catch {
      /* non-JSON error body */
    }
    if (status === 401 || status === 403) return new MetaApiError('AUTH', 'Authentication rejected (check MODEL_API_KEY)', status);
    if (status === 404 || /model_not_found|model.*(not|un)available/i.test(apiCode + ' ' + msg)) {
      return new MetaApiError('MODEL_UNAVAILABLE', `Model "${this.modelName}" unavailable: ${msg}`, status);
    }
    if (status === 429) return new MetaApiError('RATE_LIMIT', msg || 'Rate limited', status, true);
    if (status >= 500) return new MetaApiError('SERVER', msg || 'Server error', status, true);
    return new MetaApiError('BAD_REQUEST', msg || 'Request rejected', status);
  }

  /** Validates the Chat Completions response shape; never trusts it blindly. */
  parseResponse(text: string): LlmResponse {
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new MetaApiError('INVALID_RESPONSE', 'Response body is not JSON');
    }
    const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
    const message = choice?.message;
    if (!message || typeof message !== 'object') {
      throw new MetaApiError('INVALID_RESPONSE', 'Missing choices[0].message');
    }
    if (message.content != null && typeof message.content !== 'string') {
      throw new MetaApiError('INVALID_RESPONSE', 'message.content must be a string or null');
    }

    const toolCalls: ToolCall[] = [];
    if (message.tool_calls != null) {
      if (!Array.isArray(message.tool_calls)) throw new MetaApiError('INVALID_RESPONSE', 'tool_calls must be an array');
      message.tool_calls.forEach((tc: any, i: number) => {
        const name = tc?.function?.name;
        if (typeof name !== 'string' || !/^[a-zA-Z0-9_]{1,64}$/.test(name)) {
          throw new MetaApiError('INVALID_RESPONSE', `tool_calls[${i}] has an invalid function name`);
        }
        const id = typeof tc.id === 'string' && tc.id.length > 0 ? tc.id : `meta_call_${i}`;
        const rawArgs = tc.function.arguments;
        let args: Record<string, any> = {};
        let invalidArguments: string | undefined;
        if (typeof rawArgs === 'string') {
          try {
            const parsed = rawArgs.trim() === '' ? {} : JSON.parse(rawArgs);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
            else invalidArguments = 'arguments must be a JSON object';
          } catch {
            invalidArguments = 'arguments are not valid JSON';
          }
        } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
          args = rawArgs;
        } else if (rawArgs != null) {
          invalidArguments = 'arguments must be a JSON object';
        }
        toolCalls.push({ id, name, arguments: args, ...(invalidArguments ? { invalidArguments } : {}) });
      });
    }

    const u = data.usage;
    return {
      content: message.content || '',
      toolCalls,
      finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined,
      usage:
        u && typeof u === 'object'
          ? {
              promptTokens: Number(u.prompt_tokens) || 0,
              completionTokens: Number(u.completion_tokens) || 0,
              totalTokens: Number(u.total_tokens) || 0,
            }
          : undefined,
    };
  }

  private formatMessages(messages: LlmMessage[]): any[] {
    const out: any[] = [];
    for (const m of messages) {
      if (m.role === 'tool') {
        for (const r of m.toolResults || []) {
          out.push({ role: 'tool', tool_call_id: r.callId, content: r.output });
        }
        continue;
      }
      if (m.role === 'assistant') {
        const msg: any = { role: 'assistant', content: m.content || null };
        if (m.toolCalls && m.toolCalls.length > 0) {
          msg.tool_calls = m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) },
          }));
        }
        out.push(msg);
        continue;
      }
      out.push({ role: m.role, content: m.content || '' });
    }
    return out;
  }
}
