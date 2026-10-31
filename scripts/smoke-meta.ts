/**
 * Manual, LIVE smoke test for the Meta Model API. Not part of CI.
 *   cd zyron-agent && npx ts-node scripts/smoke-meta.ts
 * Requires MODEL_API_KEY in zyron-agent/.env. Makes at most two small requests.
 * Prints only the outcome (never the key).
 */
import * as dotenv from 'dotenv';
dotenv.config();
import { MetaProvider, MetaApiError } from '../src/llm/meta.provider';

async function main() {
  const provider = new MetaProvider({ maxRetries: 1 });
  console.log(`Model: ${provider.modelName}  Base URL: ${process.env.META_API_BASE_URL || 'https://api.meta.ai/v1'}`);

  const res = await provider.chat(
    [
      { role: 'system', content: 'You are a test harness. Always call the provided tool.' },
      { role: 'user', content: 'Call echo_number with n=7.' },
    ],
    [
      {
        name: 'echo_number',
        description: 'Echo a number back.',
        parameters: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
      },
    ],
  );

  console.log('finishReason:', res.finishReason);
  console.log('toolCalls:', JSON.stringify(res.toolCalls.map((t) => ({ name: t.name, arguments: t.arguments, invalid: t.invalidArguments }))));
  console.log('usage:', JSON.stringify(res.usage));
  if (res.toolCalls.length === 0) {
    console.log('NOTE: model answered without a tool call; content:', res.content.slice(0, 200));
    process.exitCode = 2;
  }
}

main().catch((e) => {
  if (e instanceof MetaApiError) console.error(`FAILED: ${e.code} ${e.httpStatus ?? ''} ${e.message}`);
  else console.error('FAILED:', e?.message || e);
  process.exitCode = 1;
});
