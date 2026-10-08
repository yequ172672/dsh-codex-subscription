import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CodexAdapter } from '../lib/adapter.js';
import { extractProviderError } from '../lib/provider-error.js';
import { translate } from '../lib/translate.js';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';

async function collect(iterable) {
  const out = [];
  for await (const value of iterable) out.push(value);
  return out;
}

async function captureError(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('expected operation to reject');
}

async function translateError(event, context = {}) {
  return captureError(() => collect(translate((async function* () { yield JSON.stringify(event); })(), context)));
}

test('extracts nested provider error fields and classifies context overflow', async () => {
  const info = await extractProviderError({
    type: 'response.failed',
    response: { status: 'failed', error: { code: 'context_length_exceeded', message: 'Context window exceeded' } },
  }, { provider: 'codex', model: 'gpt-5.6-sol' });
  assert.equal(info.code, 'context_length_exceeded');
  assert.equal(info.message, 'Context window exceeded');
  assert.equal(info.classification, 'CONTEXT_WINDOW_EXCEEDED');
});

test('extracts top-level and nested SSE error messages', async () => {
  const top = await translateError({ type: 'error', message: 'top-level failure', code: 'bad_request' });
  assert.match(top.message, /message=top-level failure/);
  assert.equal(top.code, 'PROVIDER');

  const nested = await translateError({ type: 'error', error: { detail: 'nested detail', code: 'invalid_input' } });
  assert.match(nested.message, /message=nested detail/);
  assert.match(nested.message, /code=invalid_input/);
});

test('classifies quota, rate limit, server, transport and timeout errors', async () => {
  assert.equal((await extractProviderError({ code: 'usage_limit', message: 'ChatGPT usage limit reached' })).classification, 'QUOTA');
  assert.equal((await extractProviderError({ message: 'request timed out' }, { status: 408 })).classification, 'TIMEOUT');
  assert.equal((await extractProviderError({ message: 'request timeout' }, { status: 504 })).classification, 'TIMEOUT');
  assert.equal((await extractProviderError({ message: 'too many requests' }, { status: 429 })).classification, 'RATE_LIMIT');
  assert.equal((await extractProviderError({ message: 'upstream unavailable' }, { status: 503 })).classification, 'SERVER');
  assert.equal((await extractProviderError(new Error('fetch failed: ECONNRESET'))).classification, 'TRANSPORT');
  assert.equal((await extractProviderError(new Error('request timed out'))).classification, 'TIMEOUT');
  assert.equal((await extractProviderError({ type: 'mystery', data: { value: 'x' } })).classification, 'PROVIDER');
});

test('raw summaries are bounded and redact secrets and request content', async () => {
  const info = await extractProviderError(JSON.stringify({
    error: { code: 'unknown', detail: 'x'.repeat(6000) },
    Authorization: 'Bearer secret-access-token',
    access_token: 'secret',
    cookie: 'session=secret',
    prompt: 'do not retain this prompt',
  }));
  assert.ok(info.raw.length <= 4000);
  assert.doesNotMatch(info.raw, /secret-access-token|do not retain this prompt|session=secret/);
  const text = await extractProviderError('password=hidden-secret; jwt=hidden-jwt; bearer=hidden-bearer');
  assert.doesNotMatch(text.raw, /hidden-secret|hidden-jwt|hidden-bearer/);
  assert.match(info.raw, /REDACTED/);
});

test('invalid JSON event shapes become bounded INVALID_RESPONSE errors', async () => {
  const error = await captureError(() => collect(translate((async function* () { yield 'null'; })(), { model: 'm' })));
  assert.equal(error.code, 'INVALID_RESPONSE');
  assert.match(error.message, /unrecognized upstream error/);
});

test('response.failed and invalid SSE JSON retain useful diagnostics', async () => {
  const failed = await translateError({ type: 'response.failed', error: { code: 'upstream_error', message: 'provider said no' } }, { model: 'gpt-5.6-sol' });
  assert.match(failed.message, /provider said no/);
  const malformed = await captureError(() => collect(translate((async function* () { yield '{not-json'; })(), { provider: 'codex' })));
  assert.equal(malformed.code, 'INVALID_RESPONSE');
  assert.match(malformed.message, /not-json/);
});

test('records actual priority tier in private replay metadata', async () => {
  const chunks = await collect(translate((async function* () {
    yield JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg', delta: 'ok' });
    yield JSON.stringify({ type: 'response.completed', response: { service_tier: 'priority' } });
  })(), { model: 'gpt-5.6-luna-fast', requestedServiceTier: 'priority' }));
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.deepEqual(finish.replayState.response, {
    requestedServiceTier: 'priority',
    actualServiceTier: 'priority',
    serviceTierStatus: 'fulfilled',
  });
  assert.equal(Object.hasOwn(finish, 'serviceTier'), false);
});

test('records Fast downgrade without failing normal completion', async () => {
  const chunks = await collect(translate((async function* () {
    yield JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg', delta: 'ok' });
    yield JSON.stringify({ type: 'response.completed', response: { service_tier: 'default' } });
  })(), { model: 'gpt-5.6-luna-fast', requestedServiceTier: 'priority' }));
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'stop');
  assert.equal(finish.replayState.response.serviceTierStatus, 'downgraded');
  assert.equal(finish.replayState.response.actualServiceTier, 'default');
});

test('ordinary completion has no Fast replay metadata', async () => {
  const chunks = await collect(translate((async function* () {
    yield JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg', delta: 'ok' });
    yield JSON.stringify({ type: 'response.completed', response: {} });
  })(), { model: 'gpt-5.6-luna' }));
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.equal(Object.hasOwn(finish, 'replayState'), false);
});

test('DSH BlockAssembler preserves response replay metadata', async () => {
  const chunks = await collect(translate((async function* () {
    yield JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg', delta: 'ok' });
    yield JSON.stringify({ type: 'response.completed', response: { service_tier: 'default' } });
  })(), { model: 'gpt-5.6-luna-fast', requestedServiceTier: 'priority' }));
  const assembler = new BlockAssembler();
  for (const chunk of chunks) assembler.push(chunk);
  assert.equal(assembler.replayState.response.serviceTierStatus, 'downgraded');
});

test('translates complete tool calls, done-only arguments, and mixed completion', async () => {
  const chunks = await collect(translate((async function* () {
    yield JSON.stringify({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'run' } });
    yield JSON.stringify({ type: 'response.function_call_arguments.done', item_id: 'fc_1', call_id: 'call_1', arguments: '{"x":1}' });
    yield JSON.stringify({ type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'run', arguments: '{"x":1}' } });
    yield JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg', delta: 'done' });
    yield JSON.stringify({ type: 'response.completed', response: {} });
  })(), { model: 'm' }));
  const tool = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call');
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.deepEqual(tool.block, { type: 'tool-call', id: 'call_1', name: 'run', arguments: '{"x":1}' });
  assert.equal(finish.reason.kind, 'tool-calls');
  assert.equal(finish.reason.failure, undefined);
});

test('classifies nested incomplete max-token responses and keeps usage', async () => {
  const chunks = await collect(translate((async function* () {
    yield JSON.stringify({ type: 'response.incomplete', response: {
      incomplete_details: { reason: 'max_output_tokens' },
      usage: { input_tokens: 10, output_tokens: 3 },
      service_tier: 'default',
    } });
  })(), { model: 'm', requestedServiceTier: 'priority' }));
  assert.deepEqual(chunks.find((chunk) => chunk.type === 'usage').usage, { inputTokens: 10, outputTokens: 3 });
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'max-tokens');
  assert.equal(finish.replayState.response.actualServiceTier, 'default');
});

test('counts one tool call across multiple argument deltas and rejects malformed ids', async () => {
  const chunks = await collect(translate((async function* () {
    yield JSON.stringify({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'run' } });
    yield JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_2', call_id: 'call_2', delta: '{' });
    yield JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_2', call_id: 'call_2', delta: '}' });
    yield JSON.stringify({ type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'run', arguments: '{}' } });
    yield JSON.stringify({ type: 'response.completed', response: {} });
  })(), { model: 'm' }));
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'tool-calls');
  assert.equal(finish.replayState, undefined);

  const malformed = await translateError({ type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call_bad' } });
  assert.equal(malformed.code, 'INVALID_RESPONSE');
});

test('deduplicates full arguments.done after prior argument deltas', async () => {
  const chunks = await collect(translate((async function* () {
    yield JSON.stringify({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_3', call_id: 'call_3', name: 'run' } });
    yield JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_3', call_id: 'call_3', delta: '{"x":1}' });
    yield JSON.stringify({ type: 'response.function_call_arguments.done', item_id: 'fc_3', call_id: 'call_3', arguments: '{"x":1}' });
    yield JSON.stringify({ type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_3', call_id: 'call_3', name: 'run', arguments: '{"x":1}' } });
    yield JSON.stringify({ type: 'response.completed', response: {} });
  })(), { model: 'm' }));
  const tool = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call');
  assert.equal(tool.block.arguments, '{"x":1}');
});

test('natural SSE close is STREAM_CLOSED and includes stream facts', async () => {
  const error = await captureError(() => collect(translate((async function* () { yield JSON.stringify({ type: 'response.created' }); })(), { model: 'm' })));
  assert.equal(error.code, 'STREAM_CLOSED');
  assert.match(error.message, /SSE stream ended without a terminal response event/);
});

function adapterForResponse(responseFactory, refresh) {
  return new CodexAdapter({
    options: () => ({ clientVersion: 'test' }),
    credentials: {
      current: async () => ({ mode: 'chatgpt', accessToken: 'token', baseURL: 'https://chatgpt.test' }),
      ...(refresh ? { refresh } : {}),
    },
    transport: async () => ({ fetch: responseFactory }),
  });
}

async function requestError(adapter) {
  return captureError(async () => {
    for await (const _chunk of adapter.request({ provider: 'codex', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, new AbortController().signal, () => {})) {}
  });
}

test('HTTP errors read text once, preserve request id and retry-after', async () => {
  let calls = 0;
  const adapter = adapterForResponse(async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'Context window exceeded' } }), {
      status: 400,
      headers: { 'x-request-id': 'req_test', 'retry-after': '2' },
    });
  });
  const error = await requestError(adapter);
  assert.equal(calls, 1);
  assert.equal(error.code, 'CONTEXT_WINDOW_EXCEEDED');
  assert.equal(error.failure.status, 400);
  assert.equal(error.failure.requestId, 'req_test');
  assert.equal(error.failure.providerRetryAfterMs, 2000);
  assert.match(error.message, /requestId=req_test/);
  assert.match(error.message, /raw=/);
});

test('HTTP non-JSON and body-read failures stay observable', async () => {
  const textError = await requestError(adapterForResponse(async () => new Response('gateway exploded', { status: 503, statusText: 'Unavailable' })));
  assert.equal(textError.code, 'SERVER');
  assert.match(textError.message, /gateway exploded/);

  const response = { ok: false, status: 500, statusText: 'Oops', headers: new Headers(), text: async () => { throw new Error('body unavailable'); } };
  const bodyError = await requestError(adapterForResponse(async () => response));
  assert.equal(bodyError.code, 'SERVER');
  assert.match(bodyError.message, /body read failed/);
});

test('401 refresh is attempted once and refresh failure is AUTH', async () => {
  let calls = 0;
  const adapter = adapterForResponse(async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: 'expired token' } }), { status: 401, headers: { 'x-request-id': 'req_401' } });
  }, async () => { throw new Error('OAuth refresh failure'); });
  const error = await requestError(adapter);
  assert.equal(calls, 1);
  assert.equal(error.code, 'AUTH');
  assert.equal(error.failure.status, 401);
  assert.match(error.message, /req_401/);
  assert.doesNotMatch(error.message, /Bearer\s+[^[]|access_token|refresh_token|secret-access-token/i);
});
