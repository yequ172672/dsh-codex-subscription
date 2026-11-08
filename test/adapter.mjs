import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAdapter } from '../lib/adapter.js';
import { DEFAULT_CODEX_CLIENT_VERSION } from '../lib/constants.js';

const old = { mode: 'chatgpt', baseURL: 'https://example.invalid/backend-api', accessToken: 'fixture-old', accountId: 'fixture-account' };
const fresh = { ...old, accessToken: 'fixture-new' };
const options = { provider: 'codex', model: 'fixture-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] };
const complete = () => new Response([
  { type: 'response.output_text.delta', item_id: 'msg-1', delta: 'ok' },
  { type: 'response.completed', response: { status: 'completed' } },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
async function collect(iterator) { const chunks = []; for await (const chunk of iterator) chunks.push(chunk); return chunks; }

test('401 retry rereads current in-memory credentials after refresh', async () => {
  const sent = [];
  let reads = 0, refreshes = 0;
  let active = old;
  const adapter = new CodexAdapter({
    options: () => ({ writeBack: false }),
    credentials: { current: async () => { reads += 1; return active; }, refresh: async () => { refreshes += 1; active = fresh; return fresh; } },
    transport: async () => ({}),
    fetchImpl: async (_url, init) => { sent.push(init.headers.authorization); return sent.length === 1 ? Response.json({ error: { message: 'expired fixture' } }, { status: 401 }) : complete(); },
  });
  const chunks = await collect(adapter.stream(options));
  assert.deepEqual(sent, ['Bearer fixture-old', 'Bearer fixture-new']);
  assert.equal(reads, 2);
  assert.equal(refreshes, 1);
  assert.equal(chunks.at(-1).reason.kind, 'stop');
});

test('an unauthorized retry fails after one refresh', async () => {
  let calls = 0, refreshes = 0;
  const adapter = new CodexAdapter({ options: () => ({}), credentials: { current: async () => old, refresh: async () => { refreshes += 1; return fresh; } }, transport: async () => ({}), fetchImpl: async () => { calls += 1; return Response.json({}, { status: 401 }); } });
  await assert.rejects(collect(adapter.stream(options)), e => e.code === 'AUTH');
  assert.equal(calls, 2);
  assert.equal(refreshes, 1);
});

test('subscription requests normalize wire version and strip unsupported parameters', async () => {
  for (const clientVersion of [undefined, '', '   ', ' 0.167.0 ']) {
    let sent;
    const adapter = new CodexAdapter({ options: () => ({ clientVersion }), credentials: { current: async () => old }, transport: async () => ({}), fetchImpl: async (url, init) => { sent = { url, ...init }; return complete(); } });
    await collect(adapter.stream({ ...options, temperature: 0.1, maxTokens: 12, stop: ['stop'] }));
    assert.equal(sent.url, `${old.baseURL}/codex/responses`);
    assert.equal(sent.headers.version, DEFAULT_CODEX_CLIENT_VERSION);
    const body = JSON.parse(sent.body);
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    for (const key of ['max_output_tokens', 'temperature', 'stop']) assert.equal(Object.hasOwn(body, key), false);
  }
});

test('API mode preserves supported parameters without Codex-specific headers', async () => {
  let sent;
  const api = { mode: 'apikey', apiKey: 'fixture-api', baseURL: 'https://example.invalid/v1' };
  const adapter = new CodexAdapter({ options: () => ({}), credentials: { current: async () => api }, transport: async () => ({}), fetchImpl: async (url, init) => { sent = { url, ...init }; return complete(); } });
  await collect(adapter.stream({ ...options, temperature: 0.1, maxTokens: 12 }));
  assert.equal(sent.url, `${api.baseURL}/responses`);
  assert.equal(Object.hasOwn(sent.headers, 'version'), false);
  const body = JSON.parse(sent.body);
  assert.equal(body.max_output_tokens, 12);
  assert.equal(body.temperature, 0.1);
});


test('a cached model catalog still propagates caller cancellation', async () => {
  const adapter = new CodexAdapter({ options: () => ({ staticModels: [{ id: 'fixture' }] }), credentials: { current: async () => old }, transport: async () => ({}) });
  await adapter.resolveCatalog();
  const caller = new AbortController();
  const reason = new Error('caller cancelled');
  caller.abort(reason);
  await assert.rejects(adapter.resolveCatalog(caller.signal), error => error === reason);
});

test('logout after refresh is checked before retrying a request', async () => {
  let loggedOut = false, calls = 0;
  const error = new Error('fixture logged out');
  const adapter = new CodexAdapter({ options: () => ({}), credentials: { current: async () => { if (loggedOut) throw error; return old; }, refresh: async () => { loggedOut = true; return fresh; } }, transport: async () => ({}), fetchImpl: async () => { calls += 1; return Response.json({}, { status: 401 }); } });
  await assert.rejects(collect(adapter.request(options, new AbortController().signal)), e => e === error);
  assert.equal(calls, 1);
});
