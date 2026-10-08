import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, LlmError, LlmRuntime } from '@deepseek-ai/dsh-llm';

import { CodexAdapter } from '../lib/adapter.js';

class EmptyAdapter extends LlmAdapter {
  async *stream() {}
}

test('DSH 0.2 LLM runtime accepts and disposes one provider route', () => {
  const ctx = new Context();
  const llm = new LlmRuntime(ctx);
  const disposer = llm.registerAdapter(['codex'], new EmptyAdapter());
  assert.deepEqual(llm.listProviders(), [{ id: 'codex', name: 'codex' }]);
  disposer();
  assert.deepEqual(llm.listProviders(), []);
});

test('DSH 0.2 LLM runtime converts adapter failures into terminal finish', async () => {
  const ctx = new Context();
  const llm = new LlmRuntime(ctx);
  class FailingAdapter extends LlmAdapter {
    async *stream() {
      throw new LlmError('fixture failure', 'FIXTURE');
    }
  }
  llm.registerAdapter(['codex'], new FailingAdapter());
  const chunks = [];
  for await (const chunk of llm.stream({ provider: 'codex', model: 'fixture', messages: [] })) chunks.push(chunk);
  assert.deepEqual(chunks, [{
    type: 'finish',
    reason: { kind: 'error', failure: { message: 'fixture failure', code: 'FIXTURE' } },
  }]);
});

test('Codex adapter metadata satisfies DSH 0.2 exact-model normalization', async () => {
  const adapter = new CodexAdapter({
    options: () => ({ staticModels: [{ id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 1000, maxTokens: 100 }] }),
    credentials: { current: async () => ({ mode: 'chatgpt', accessToken: 'fixture', baseURL: 'https://example.test' }) },
    transport: async () => ({ fetch: async () => { throw new Error('not used'); } }),
  });
  const ctx = new Context();
  const llm = new LlmRuntime(ctx);
  llm.registerAdapter(['codex'], adapter);
  const resolved = await llm.resolveModelInfo('codex', 'fixture');
  assert.equal(resolved.provider, 'codex');
  assert.equal(resolved.id, 'fixture');
  assert.equal(resolved.context.contextWindow, 1000);
  assert.deepEqual(resolved.inputModalities, ['text']);
  assert.deepEqual(resolved.reasoning.efforts.map((effort) => effort.id), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
});

test('DSH 0.2 emits a classified aborted finish when the caller cancels', async () => {
  const ctx = new Context();
  const llm = new LlmRuntime(ctx);
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  class BlockingAdapter extends LlmAdapter {
    async *stream(options) {
      startedResolve();
      await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new LlmError('cancelled', 'ABORTED')), { once: true }));
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  llm.registerAdapter(['codex'], new BlockingAdapter());
  const controller = new AbortController();
  const chunksPromise = (async () => {
    const chunks = [];
    for await (const chunk of llm.stream({ provider: 'codex', model: 'fixture', messages: [], signal: controller.signal })) chunks.push(chunk);
    return chunks;
  })();
  await started;
  controller.abort();
  const chunks = await chunksPromise;
  assert.equal(chunks.at(-1).type, 'finish');
  assert.equal(chunks.at(-1).reason.kind, 'aborted');
  assert.equal(chunks.at(-1).reason.failure.code, 'ABORTED');
});

test('DSH 0.2 rejects duplicate provider routes without disturbing the first route', () => {
  const ctx = new Context();
  const llm = new LlmRuntime(ctx);
  llm.registerAdapter(['codex'], new EmptyAdapter());
  assert.throws(() => llm.registerAdapter(['codex'], new EmptyAdapter()), { code: 'DUPLICATE_ADAPTER' });
  assert.deepEqual(llm.listProviders(), [{ id: 'codex', name: 'codex' }]);
});
