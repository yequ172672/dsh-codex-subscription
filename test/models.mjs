import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CodexAdapter } from '../lib/adapter.js';
import { completeEntry } from '../lib/models.js';

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
      { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', input: ['text', 'image'], contextWindow: 272000, maxTokens: 128000 },
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

test('request sends image input to the existing Codex Responses endpoint', async () => {
  const attachment = { attachmentId: 'request-image', mediaType: 'image/png', bytes: 1 };
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
