import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCatalog, discoverModelsLive, readModelsCacheFile, STATIC_MODELS, completeEntry } from '../lib/models.js';
import { DEFAULT_CODEX_CLIENT_VERSION } from '../lib/constants.js';

const chat = { mode: 'chatgpt', baseURL: 'https://example.invalid/backend-api/', accessToken: 'fixture', accountId: 'fixture-account' };
const api = { mode: 'apikey', baseURL: 'https://example.invalid/v1/', apiKey: 'fixture' };
const response = (data) => ({ ok: true, json: async () => data });
const fixture = { models: [
  { slug: 'fixture-model', display_name: 'Fixture', context_window: 12345, default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }, 'high', null] },
  { slug: 'hidden-one', visibility: 'hide' },
  { id: 'hidden-two', visibility: 'HIDDEN' },
  null, { id: '' }, { slug: 'fixture-model' },
] };

test('subscription URL, trimmed/default version, and combined signal', async () => {
  for (const [version, expected] of [['  custom  ', 'custom'], [' ', DEFAULT_CODEX_CLIENT_VERSION], [undefined, DEFAULT_CODEX_CLIENT_VERSION]]) {
    const caller = new AbortController();
    await discoverModelsLive(chat, version, caller.signal, { fetch: async (url, options) => {
      assert.equal(url.pathname, '/backend-api/codex/models');
      assert.equal(url.searchParams.get('client_version'), expected);
      assert.equal(options.headers.version, expected);
      assert.equal(options.headers['chatgpt-account-id'], 'fixture-account');
      assert.notEqual(options.signal, caller.signal);
      return response(fixture);
    } });
  }
});

test('API key uses /models without subscription headers or query', async () => {
  const entries = await discoverModelsLive(api, undefined, undefined, { fetch: async (url, options) => {
    assert.equal(url.href, 'https://example.invalid/v1/models');
    assert.equal(options.headers.version, undefined);
    assert.equal(options.headers.originator, undefined);
    assert.equal(options.headers['chatgpt-account-id'], undefined);
    return response({ data: [{ id: 'api-fixture' }] });
  } });
  assert.equal(entries[0].id, 'api-fixture');
});

test('live and cache share parsing; filter hidden/invalid entries and dedupe', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-models-test-'));
  try {
    const file = join(dir, 'models.json');
    await writeFile(file, JSON.stringify(fixture));
    const live = await discoverModelsLive(chat, undefined, undefined, { fetch: async () => response(fixture) });
    assert.deepEqual(await readModelsCacheFile(file), live);
    const catalog = await buildCatalog(chat, { modelsCacheFile: file }, undefined, { fetch: async () => ({ ok: false }) });
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].name, 'Fixture');
    assert.equal(catalog[0].contextWindow, 12345);
    assert.equal(catalog[0].defaultEffort, 'low');
    assert.deepEqual(catalog[0].efforts, ['low', 'high']);
    await writeFile(file, 'invalid json');
    assert.equal(await readModelsCacheFile(file), null);
    const fallback = await buildCatalog(chat, { modelsCacheFile: file }, undefined, { fetch: async () => { throw new Error('offline'); } });
    assert.deepEqual(fallback.map(x => x.id), STATIC_MODELS.map(x => x.id));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('static metadata wins and retains reasoning configuration', async () => {
  const entry = { id: 'static-fixture', name: 'Static', contextWindow: 2000, maxTokens: 500, defaultEffort: 'high', efforts: ['high'] };
  const catalog = await buildCatalog(chat, { staticModels: [entry, entry] }, undefined, { fetch: () => assert.fail('must not fetch') });
  assert.deepEqual(catalog, [entry]);
});

test('caller abort is never treated as discovery failure', async () => {
  const caller = new AbortController();
  const reason = new Error('caller cancelled');
  await assert.rejects(buildCatalog(chat, {}, caller.signal, { fetch: async (_url, options) => {
    caller.abort(reason);
    assert.equal(options.signal.aborted, true);
    throw reason;
  } }), error => error === reason);
  await assert.rejects(buildCatalog(chat, { staticModels: [{ id: 'unused' }] }, caller.signal, { fetch: () => assert.fail('must not fetch') }), error => error === reason);
  const direct = new AbortController();
  await assert.rejects(discoverModelsLive(chat, undefined, direct.signal, { fetch: async () => {
    direct.abort(reason);
    throw reason;
  } }), error => error === reason);
});

test('discovery deadline remains active with caller signal; timeout allows fallback', async (t) => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    assert.equal(milliseconds, 10000);
    return deadline.signal;
  });
  const caller = new AbortController();
  const result = await discoverModelsLive(chat, undefined, caller.signal, { fetch: async (_url, options) => {
    deadline.abort(new DOMException('deadline', 'TimeoutError'));
    assert.equal(options.signal.aborted, true);
    options.signal.throwIfAborted();
  } });
  assert.equal(result, null);
  assert.equal(caller.signal.aborted, false);
});


test('fallback contains the verified 6.1 Terra model and conservative current context', () => {
  for (const id of ['gpt-6.1-sol', 'gpt-6.1-terra']) {
    const entry = STATIC_MODELS.find(item => item.id === id);
    assert.ok(entry);
    assert.equal(completeEntry(entry).contextWindow, 500000);
    assert.equal(completeEntry({ id }).contextWindow, 500000);
  }
});
