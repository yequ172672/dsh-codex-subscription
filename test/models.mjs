import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CodexAdapter } from '../lib/adapter.js';
import { buildCatalog, completeEntry, expandCatalogEntries } from '../lib/models.js';
import { resolveWireModel } from '../lib/service-tier.js';

test('catalog creates Fast rows only from explicit priority or legacy fast metadata', () => {
  const rows = expandCatalogEntries([
    {
      id: 'priority-model', name: 'Priority', input: ['text', 'image'], contextWindow: 1000,
      serviceTiers: [{ id: 'priority', name: 'Fast', description: 'priority lane' }],
      efforts: ['low', 'high'],
    },
    { id: 'legacy-model', name: 'Legacy', additionalSpeedTiers: ['fast'] },
    { id: 'unknown-tier', name: 'Unknown', serviceTiers: [{ id: 'ultrafast', name: 'UltraFast' }] },
    { id: 'name-only', name: 'Name Fast', serviceTiers: [{ id: 'standard', name: 'Fast' }] },
  ]);
  assert.deepEqual(rows.map((entry) => entry.id), [
    'priority-model', 'priority-model-fast', 'legacy-model', 'legacy-model-fast', 'unknown-tier', 'name-only',
  ]);
  const fast = rows.find((entry) => entry.id === 'priority-model-fast');
  assert.deepEqual(fast.input, ['text', 'image']);
  assert.equal(fast.contextWindow, 1000);
  assert.deepEqual(fast.efforts, ['low', 'high']);
});

test('catalog merges pre-suffixed and base entries without duplicate Fast rows', () => {
  const rows = expandCatalogEntries([
    { id: 'gpt-5.6-luna-fast', name: 'GPT-5.6 Luna Fast', input: ['text', 'image'], serviceTiers: [{ id: 'priority' }] },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', input: ['text', 'image'], contextWindow: 372000 },
    { id: 'gpt-5.6-luna-fast', name: 'Duplicate Fast' },
  ]);
  assert.deepEqual(rows.map((entry) => entry.id), ['gpt-5.6-luna', 'gpt-5.6-luna-fast']);
  assert.equal(rows[1].name, 'GPT-5.6 Luna Fast');
  assert.deepEqual(rows[0].input, ['text', 'image']);
  assert.deepEqual(resolveWireModel(rows[1].id), { wireId: 'gpt-5.6-luna', serviceTier: 'priority' });
});

test('models cache decoder preserves legacy and modern Fast metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-codex-models-'));
  const file = join(directory, 'models_cache.json');
  try {
    await writeFile(file, JSON.stringify({ models: [
      { slug: 'modern', display_name: 'Modern', service_tiers: [{ id: 'priority', name: 'Fast' }] },
      { slug: 'legacy', display_name: 'Legacy', additional_speed_tiers: ['fast'] },
    ] }));
    const { readModelsCacheFile } = await import('../lib/models.js');
    const entries = await readModelsCacheFile(file);
    const rows = expandCatalogEntries(entries);
    assert.deepEqual(rows.map((entry) => entry.id), ['modern', 'modern-fast', 'legacy', 'legacy-fast']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('model entries default to text input and preserve configured modalities', () => {
  assert.deepEqual(completeEntry({ id: 'gpt-5.5' }).input, ['text']);
  assert.deepEqual(completeEntry({ id: 'gpt-5.6-sol', input: ['text', 'image'] }).input, ['text', 'image']);
  assert.deepEqual(completeEntry({ id: 'gpt-5.6-luna', input: ['text', 'image'] }).input, ['text', 'image']);
  assert.deepEqual(completeEntry({ id: 'gpt-5.6-terra', input: ['text', 'image'] }).input, ['text', 'image']);
  assert.deepEqual(completeEntry({ id: 'gpt-5.6-luna', input: ['image', 'unknown', 'image'] }).input, ['image']);
});

test('listModels and resolveModel expose the same configured input modalities', async () => {
  const config = {
    clientVersion: 'test',
    staticModels: [
      { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', input: ['text', 'image'], contextWindow: 272000, maxTokens: 128000, serviceTiers: [{ id: 'priority', name: 'Fast' }] },
      { id: 'gpt-5.5', name: 'GPT-5.5', input: ['text'], contextWindow: 272000, maxTokens: 128000 },
    ],
  };
  const credentials = {
    async current() {
      return { mode: 'chatgpt', accessToken: 'test-token', baseURL: 'https://example.test' };
    },
  };
  const adapter = new CodexAdapter({
    options: () => config,
    credentials,
    transport: async () => ({ fetch: async () => { throw new Error('network should not be used'); } }),
  });

  const listed = await adapter.listModels('codex');
  const resolved = await adapter.resolveModel('codex', 'gpt-5.6-luna');
  assert.deepEqual(listed.find((model) => model.id === 'gpt-5.6-luna').inputModalities, ['text', 'image']);
  assert.deepEqual(resolved.inputModalities, ['text', 'image']);
});

test('resolveModel preserves inherited Fast capabilities', async () => {
  const config = {
    clientVersion: 'test',
    staticModels: [{
      id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', input: ['text', 'image'],
      contextWindow: 372000, maxTokens: 128000, serviceTiers: [{ id: 'priority', name: 'Fast' }],
    }],
  };
  const adapter = new CodexAdapter({
    options: () => config,
    credentials: { current: async () => ({ mode: 'chatgpt', accessToken: 'token', baseURL: 'https://example.test' }) },
    transport: async () => ({ fetch: async () => { throw new Error('network should not be used'); } }),
  });
  const resolved = await adapter.resolveModel('codex', 'gpt-5.6-luna-fast');
  assert.equal(resolved.id, 'gpt-5.6-luna-fast');
  assert.equal(resolved.name, 'GPT-5.6-Luna Fast');
  assert.deepEqual(resolved.inputModalities, ['text', 'image']);
  assert.equal(resolved.context.contextWindow, 372000);
  assert.deepEqual(resolved.reasoning.efforts.map((effort) => effort.name), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
});

test('unknown Fast model resolves with safe defaults without catalog advertisement', async () => {
  const config = { clientVersion: 'test', staticModels: [{ id: 'known', name: 'Known' }] };
  const adapter = new CodexAdapter({
    options: () => config,
    credentials: { current: async () => ({ mode: 'chatgpt', accessToken: 'token', baseURL: 'https://example.test' }) },
    transport: async () => ({ fetch: async () => { throw new Error('network should not be used'); } }),
  });
  const listed = await adapter.listModels('codex');
  assert.equal(listed.some((model) => model.id === 'unknown-fast'), false);
  const resolved = await adapter.resolveModel('codex', 'unknown-fast');
  assert.equal(resolved.id, 'unknown-fast');
  assert.equal(resolved.inputModalities[0], 'text');
});

test('prepared calls retain one configuration generation across model resolution and dispatch', async () => {
  const generations = [
    { clientVersion: 'old', proxy: 'http://old.test', streamIdleTimeoutMs: 1000 },
    { clientVersion: 'new', proxy: 'http://new.test', streamIdleTimeoutMs: 1000 },
  ];
  let generation = 0;
  const transports = [];
  const credentials = {
    current: async (config) => ({ mode: 'chatgpt', accessToken: config.clientVersion, baseURL: 'https://chatgpt.test' }),
  };
  const adapter = new CodexAdapter({
    options: () => generations[generation],
    credentials,
    transport: async (config) => {
      transports.push(config.clientVersion);
      return {
        fetch: async (_url, init) => new Response(
          'data: {"type":"response.output_text.delta","item_id":"msg","delta":"ok"}\n\ndata: {"type":"response.completed","response":{}}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      };
    },
  });

  const prepared = await adapter.prepareCall('codex', 'known', undefined);
  generation = 1;
  const chunks = [];
  for await (const chunk of prepared.stream({
    provider: 'codex',
    model: 'known',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
  })) chunks.push(chunk);

  assert.deepEqual(transports, ['old']);
  assert.equal(chunks.at(-1).type, 'finish');
  assert.equal(chunks.at(-1).reason.kind, 'stop');

  const next = await adapter.prepareCall('codex', 'known', undefined);
  assert.equal(next.model.id, 'known');
  assert.equal(transports.at(-1), 'new');
});

test('request sends image input to the existing Codex Responses endpoint', async () => {
  const attachment = { attachmentId: 'request-image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 };
  let request;
  const adapter = new CodexAdapter({
    options: () => ({ clientVersion: 'test', requestImagePixelBudget: 16, requestImageMaxBytes: 16 }),
    credentials: { current: async () => ({ mode: 'chatgpt', accessToken: 'token', baseURL: 'https://chatgpt.test' }) },
    transport: async () => ({
      fetch: async (url, init) => {
        request = { url, init };
        return new Response('data: {"type":"response.completed","response":{}}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    }),
    resolveAttachments: () => ({
      readImageRequest: async () => ({ ...attachment, data: new Uint8Array([7]) }),
    }),
  });

  for await (const _chunk of adapter.request(
    { model: 'gpt-5.6-luna', messages: [{ role: 'user', content: [{ type: 'image', attachment }] }] },
    new AbortController().signal,
    () => {},
  )) {
    // The mock completion event intentionally produces no stream chunk.
  }

  const body = JSON.parse(request.init.body);
  assert.equal(request.url, 'https://chatgpt.test/codex/responses');
  assert.deepEqual(body.input[0].content[0], {
    type: 'input_image',
    detail: 'auto',
    image_url: 'data:image/png;base64,Bw==',
  });
});

test('request sends Fast wire mapping and keeps it on 401 refresh retry', async () => {
  const requests = [];
  let refreshed = false;
  const adapter = new CodexAdapter({
    options: () => ({ clientVersion: 'test' }),
    credentials: {
      current: async () => ({ mode: 'chatgpt', accessToken: refreshed ? 'new-token' : 'token', baseURL: 'https://chatgpt.test' }),
      refresh: async () => { refreshed = true; },
    },
    transport: async () => ({
      fetch: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        if (requests.length === 1) return new Response('{"error":{"message":"expired"}}', { status: 401 });
        return new Response('data: {"type":"response.output_text.delta","item_id":"msg","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"service_tier":"priority"}}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    }),
  });
  for await (const _chunk of adapter.request({ model: 'gpt-5.6-luna-fast', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, new AbortController().signal, () => {})) {}
  assert.equal(requests.length, 2);
  assert.deepEqual({ model: requests[0].model, service_tier: requests[0].service_tier }, { model: 'gpt-5.6-luna', service_tier: 'priority' });
  assert.deepEqual(requests[1], requests[0]);
});

test('service-tier rejection stays INVALID_REQUEST without ordinary fallback', async () => {
  let calls = 0;
  const adapter = new CodexAdapter({
    options: () => ({ clientVersion: 'test' }),
    credentials: { current: async () => ({ mode: 'chatgpt', accessToken: 'token', baseURL: 'https://chatgpt.test' }) },
    transport: async () => ({
      fetch: async (_url, init) => {
        calls += 1;
        const body = JSON.parse(init.body);
        assert.equal(body.model, 'gpt-5.6-luna');
        assert.equal(body.service_tier, 'priority');
        return new Response(JSON.stringify({ error: { code: 'unsupported_parameter', message: 'service_tier unsupported' } }), { status: 400 });
      },
    }),
  });
  await assert.rejects((async () => {
    for await (const _chunk of adapter.request({ model: 'gpt-5.6-luna-fast', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, new AbortController().signal, () => {})) {}
  })(), (error) => error.code === 'INVALID_REQUEST');
  assert.equal(calls, 1);
});

test('maps a provider HTTP 400 to INVALID_REQUEST', async () => {
  const adapter = new CodexAdapter({
    options: () => ({ clientVersion: 'test' }),
    credentials: { current: async () => ({ mode: 'chatgpt', accessToken: 'token', baseURL: 'https://chatgpt.test' }) },
    transport: async () => ({
      fetch: async () => new Response(JSON.stringify({ error: { message: 'image not supported' } }), { status: 400 }),
    }),
  });

  await assert.rejects(
    (async () => {
      for await (const _chunk of adapter.request(
        { model: 'gpt-5.6-luna', messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] },
        new AbortController().signal,
        () => {},
      )) {
        // The request is expected to fail before any stream chunk.
      }
    })(),
    (error) => error.code === 'INVALID_REQUEST' && error.failure.status === 400,
  );
});
