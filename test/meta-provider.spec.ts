import { describe, it, expect, vi } from 'vitest';
import { MetaProvider, MetaApiError, HttpFetch, MetaProviderLogEvent } from '../src/llm/meta.provider';
import { createLlmProvider, resolveProviderName } from '../src/llm/provider-factory';
import { ToolDefinition } from '../src/llm/types';

// All tests here use a mocked HTTP transport. No network calls are made.

function res(status: number, body: any, headers: Record<string, string> = {}) {
  return {
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const okToolCall = {
  id: 'cmpl-1',
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"filePath":"src/Vault.sol"}' } },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

const tools: ToolDefinition[] = [
  { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] } },
];

function make(fetchImpl: HttpFetch, extra: Partial<ConstructorParameters<typeof MetaProvider>[0]> = {}) {
  const events: MetaProviderLogEvent[] = [];
  const sleeps: number[] = [];
  const p = new MetaProvider({
    apiKey: 'sk-test-SECRET',
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    logger: (e) => events.push(e),
    maxRetries: 3,
    ...extra,
  });
  return { p, events, sleeps };
}

describe('MetaProvider (mocked HTTP)', () => {
  it('sends an OpenAI-compatible request with bearer auth and parses tool calls', async () => {
    const fetchImpl = vi.fn(async () => res(200, okToolCall)) as unknown as HttpFetch;
    const { p, events } = make(fetchImpl);

    const out = await p.chat(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'read_file', arguments: { filePath: 'a.sol' } }] },
        { role: 'tool', toolResults: [{ callId: 'c0', name: 'read_file', output: 'contract A {}' }] },
      ],
      tools,
    );

    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe('https://api.meta.ai/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-test-SECRET');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('muse-spark-1.3');
    expect(body.tool_choice).toBe('auto');
    expect(body.tools[0]).toEqual({ type: 'function', function: { name: 'read_file', description: 'read', parameters: tools[0].parameters } });
    expect(body.messages[2].tool_calls[0].function.arguments).toBe('{"filePath":"a.sol"}');
    expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c0', content: 'contract A {}' });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('stop');

    expect(out.toolCalls).toEqual([{ id: 'call_a', name: 'read_file', arguments: { filePath: 'src/Vault.sol' } }]);
    expect(out.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    // Secret never logged
    expect(JSON.stringify(events)).not.toContain('SECRET');
  });

  it('flags malformed tool arguments instead of throwing', async () => {
    const bad = JSON.parse(JSON.stringify(okToolCall));
    bad.choices[0].message.tool_calls[0].function.arguments = '{not json';
    const { p } = make(async () => res(200, bad));
    const out = await p.chat([{ role: 'user', content: 'x' }], tools);
    expect(out.toolCalls[0].arguments).toEqual({});
    expect(out.toolCalls[0].invalidArguments).toMatch(/not valid JSON/);
  });

  it('rejects structurally invalid responses', async () => {
    const { p } = make(async () => res(200, { choices: [] }));
    await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    const { p: p2 } = make(async () => res(200, 'not json'));
    await expect(p2.chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    const badName = JSON.parse(JSON.stringify(okToolCall));
    badName.choices[0].message.tool_calls[0].function.name = 'rm -rf /';
    const { p: p3 } = make(async () => res(200, badName));
    await expect(p3.chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('retries 429 honoring Retry-After, then succeeds', async () => {
    let n = 0;
    const { p, sleeps } = make(async () => (++n === 1 ? res(429, { error: { message: 'slow down' } }, { 'retry-after': '2' }) : res(200, okToolCall)));
    const out = await p.chat([{ role: 'user', content: 'x' }], tools);
    expect(n).toBe(2);
    expect(sleeps).toEqual([2000]);
    expect(out.toolCalls).toHaveLength(1);
  });

  it('gives up after bounded retries on 5xx', async () => {
    let n = 0;
    const { p, sleeps } = make(async () => {
      n++;
      return res(503, { error: { message: 'overloaded' } });
    });
    await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'SERVER', httpStatus: 503 });
    expect(n).toBe(4); // 1 + maxRetries(3)
    expect(sleeps).toHaveLength(3);
  });

  it('does not retry auth errors or unavailable models', async () => {
    let n = 0;
    const { p } = make(async () => {
      n++;
      return res(401, { error: { message: 'bad key' } });
    });
    await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'AUTH' });
    expect(n).toBe(1);

    const { p: p2 } = make(async () => res(404, { error: { code: 'model_not_found', message: 'no such model' } }));
    await expect(p2.chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  });

  it('times out a hung request and retries', async () => {
    let n = 0;
    const hang: HttpFetch = (_u, init) =>
      new Promise((_resolve, reject) => {
        n++;
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    const { p } = make(hang, { timeoutMs: 20, maxRetries: 1 });
    await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(n).toBe(2);
  });

  it('honors cancellation via AbortSignal without retrying', async () => {
    const ac = new AbortController();
    let n = 0;
    const hang: HttpFetch = (_u, init) =>
      new Promise((_resolve, reject) => {
        n++;
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        setTimeout(() => ac.abort(), 5);
      });
    const { p } = make(hang, { timeoutMs: 10_000 });
    await expect(p.chat([{ role: 'user', content: 'x' }], undefined, { signal: ac.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(n).toBe(1);
  });

  it('fails fast without an API key', async () => {
    const p = new MetaProvider({ apiKey: '', fetchImpl: async () => res(200, okToolCall) });
    await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(MetaApiError);
  });

  it('refuses non-https base URLs', () => {
    expect(() => new MetaProvider({ apiKey: 'k', baseUrl: 'http://evil.example.com/v1' })).toThrow(/https/);
  });
});

describe('provider factory', () => {
  it('selects meta when MODEL_API_KEY is set, gemini otherwise, and honors LLM_PROVIDER', () => {
    expect(resolveProviderName({ MODEL_API_KEY: 'k' } as any)).toBe('meta');
    expect(resolveProviderName({} as any)).toBe('gemini');
    expect(resolveProviderName({ LLM_PROVIDER: 'gemini', MODEL_API_KEY: 'k' } as any)).toBe('gemini');
    expect(() => resolveProviderName({ LLM_PROVIDER: 'other' } as any)).toThrow();
    const p = createLlmProvider({ LLM_PROVIDER: 'meta', MODEL_API_KEY: 'k', META_MODEL: 'muse-spark-1.3' } as any);
    expect(p.providerName).toBe('meta');
    expect(p.modelName).toBe('muse-spark-1.3');
  });
});
