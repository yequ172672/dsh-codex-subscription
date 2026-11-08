import assert from 'node:assert/strict';
import test from 'node:test';
import { BlockAssembler, EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm';
import { mapUsage, translate } from '../lib/translate.js';

const event = (type, fields = {}) => ({ type: `response.${type}`, ...fields });
const completed = event('completed');
const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"q":"hi"}' };
const done = item => event('output_item.done', { item });
const added = item => event('output_item.added', { item });
const collect = async events => {
  const chunks = [];
  for await (const chunk of translate(events.map(JSON.stringify))) chunks.push(chunk);
  return chunks;
};
const ends = chunks => chunks.filter(c => c.type === 'block-end').map(c => c.block);
const finish = chunks => chunks.at(-1).reason;
const assemble = chunks => {
  const assembler = new BlockAssembler();
  chunks.forEach(chunk => assembler.push(chunk));
  return assembler;
};
const textDelta = (text, id = 'msg_1', index = 0) => event('output_text.delta', { item_id: id, content_index: index, delta: text });
const textDone = (text, id = 'msg_1', index = 0) => event('output_text.done', { item_id: id, content_index: index, text });

test('normal text and tool deltas retain the harness chunk contract', async () => {
  const chunks = await collect([
    textDelta('Hello'), textDone('Hello'),
    done({ type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Hello' }] }),
    added({ ...call, arguments: '' }),
    event('function_call_arguments.delta', { item_id: call.id, delta: '{"q":' }),
    event('function_call_arguments.delta', { item_id: call.id, delta: '"hi"}' }),
    event('function_call_arguments.done', { item_id: call.id, arguments: call.arguments }),
    done(call), completed,
  ]);
  assert.deepEqual(ends(chunks), [
    { type: 'text', text: 'Hello' },
    { type: 'tool-call', id: call.call_id, name: call.name, arguments: call.arguments },
  ]);
  assert.equal(chunks.filter(c => c.type === 'tool-call-delta').map(c => c.argumentsDelta).join(''), call.arguments);
  assert.deepEqual(assemble(chunks).blocks(), ends(chunks));
  assert.deepEqual(finish(chunks), { kind: 'tool-calls' });
});

for (const prefix of [[], [added({ ...call, arguments: '' })]]) {
  test(`done-only function call recovers arguments (${prefix.length ? 'with' : 'without'} item.added)`, async () => {
    const chunks = await collect([...prefix, done(call), completed]);
    assert.equal(ends(chunks)[0].arguments, call.arguments);
    assert.equal(chunks.find(c => c.type === 'tool-call-delta').argumentsDelta, call.arguments);
    assert.deepEqual(assemble(chunks).blocks(), ends(chunks));
    assert.equal(finish(chunks).kind, 'tool-calls');
  });
}

test('arguments.done completes partial arguments and is not duplicated by item.done', async () => {
  const chunks = await collect([
    added({ ...call, arguments: '' }),
    event('function_call_arguments.delta', { item_id: call.id, delta: '{"q":' }),
    event('function_call_arguments.done', { item_id: call.id, arguments: call.arguments }),
    done(call), completed,
  ]);
  assert.equal(chunks.filter(c => c.type === 'tool-call-delta').map(c => c.argumentsDelta).join(''), call.arguments);
  assert.equal(ends(chunks)[0].arguments, call.arguments);
});

test('pending tool block at completion still requires tools', async () => {
  const chunks = await collect([
    added({ ...call, arguments: '' }),
    event('function_call_arguments.done', { item_id: call.id, arguments: call.arguments }),
    completed,
  ]);
  assert.equal(finish(chunks).kind, 'tool-calls');
  assert.equal(chunks.at(-2).type, 'block-end');
});

test('text after a tool call does not suppress tool execution', async () => {
  const chunks = await collect([done(call), textDelta('Checking now.'), completed]);
  assert.equal(finish(chunks).kind, 'tool-calls');
  assert.equal(ends(chunks).length, 2);
});

test('parallel tool calls keep independent argument streams and stable indices', async () => {
  const other = { ...call, id: 'fc_2', call_id: 'call_2', name: 'other', arguments: '{}' };
  const chunks = await collect([
    added({ ...call, arguments: '' }), added({ ...other, arguments: '' }),
    event('function_call_arguments.delta', { item_id: call.id, delta: '{"q":' }),
    event('function_call_arguments.delta', { item_id: other.id, delta: '{}' }),
    done(other), done(call), completed,
  ]);
  assert.deepEqual(chunks.filter(c => c.type === 'block-end').map(c => c.index), [1, 0]);
  assert.deepEqual(assemble(chunks).blocks().map(b => b.arguments), [call.arguments, other.arguments]);
});

test('arguments.done without item.added gains its final metadata at item.done', async () => {
  const chunks = await collect([
    event('function_call_arguments.done', { item_id: call.id, arguments: call.arguments }), done(call), completed,
  ]);
  assert.deepEqual(assemble(chunks).blocks(), [{ type: 'tool-call', id: call.call_id, name: call.name, arguments: call.arguments }]);
});

test('incomplete tool response is not incorrectly marked ready for execution', async () => {
  const chunks = await collect([
    added({ ...call, arguments: '' }),
    event('function_call_arguments.delta', { item_id: call.id, delta: '{"q":' }),
    event('incomplete', { response: { incomplete_details: { reason: 'max_output_tokens' } } }),
  ]);
  assert.equal(finish(chunks).kind, 'max-tokens');
  assert.deepEqual(assemble(chunks).blocks(), []);
});

test('reasoning closes at its own item.done before the next message starts', async () => {
  const chunks = await collect([
    event('reasoning_summary_text.delta', { item_id: 'rs_1', summary_index: 0, delta: 'Think' }),
    event('reasoning_summary_text.done', { item_id: 'rs_1', summary_index: 0, text: 'Thinking' }),
    done({ id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Thinking' }] }),
    textDelta('Answer'), completed,
  ]);
  assert.deepEqual(chunks.slice(0, 5).map(c => c.type), ['block-start', 'reasoning-delta', 'reasoning-delta', 'block-end', 'block-start']);
  assert.deepEqual(ends(chunks), [{ type: 'reasoning', text: 'Thinking' }, { type: 'text', text: 'Answer' }]);
  assert.equal(finish(chunks).kind, 'stop');
});

test('done-only message and reasoning item snapshots preserve full content', async () => {
  const chunks = await collect([
    done({ id: 'rs', type: 'reasoning', summary: [{ type: 'summary_text', text: 'A' }, { type: 'summary_text', text: 'B' }] }),
    done({ id: 'msg', type: 'message', content: [{ type: 'output_text', text: 'C' }, { type: 'refusal', refusal: 'D' }] }),
    completed,
  ]);
  assert.deepEqual(ends(chunks), [{ type: 'reasoning', text: 'AB' }, { type: 'text', text: 'CD' }]);
  assert.deepEqual(assemble(chunks).blocks(), ends(chunks));
});

test('text done snapshots are deduplicated per content part', async () => {
  const chunks = await collect([
    textDelta('A'), textDone('AB'), textDelta('C', 'msg_1', 1), textDone('CD', 'msg_1', 1),
    done({ id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: 'AB' }, { type: 'output_text', text: 'CD' }] }),
    completed,
  ]);
  assert.deepEqual(ends(chunks), [{ type: 'text', text: 'ABCD' }]);
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'ABCD');
});

test('standalone output_text.done and refusal.done produce content', async () => {
  const chunks = await collect([
    textDone('Answer'),
    event('refusal.done', { item_id: 'msg_2', content_index: 0, refusal: 'Cannot comply' }),
    completed,
  ]);
  assert.deepEqual(ends(chunks), [{ type: 'text', text: 'Answer' }, { type: 'text', text: 'Cannot comply' }]);
});

const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 30 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 } };
const mappedUsage = { inputTokens: 70, cacheReadTokens: 30, outputTokens: 20, reasoningTokens: 5 };
test('usage maps cached input separately and retains reasoning tokens', () => {
  assert.deepEqual(mapUsage(usage), mappedUsage);
  assert.equal(mapUsage(null), undefined);
  assert.deepEqual(mapUsage({}), { inputTokens: 0, outputTokens: 0 });
});

for (const terminal of ['completed', 'done', 'incomplete']) {
  test(`${terminal}: nested usage follows closed blocks and precedes finish`, async () => {
    const chunks = await collect([
      event('usage', { usage: { input_tokens: 1 } }), textDelta('Answer'),
      event(terminal, { response: { usage, incomplete_details: { reason: 'max_output_tokens' } } }),
    ]);
    assert.deepEqual(chunks.slice(-3).map(c => c.type), ['block-end', 'usage', 'finish']);
    assert.deepEqual(chunks.at(-2).usage, mappedUsage);
    assert.equal(chunks.filter(c => c.type === 'usage').length, 1);
    assert.equal(finish(chunks).kind, terminal === 'incomplete' ? 'max-tokens' : 'stop');
  });
}

test('legacy usage and incomplete reason remain supported', async () => {
  const chunks = await collect([textDelta('A'), event('incomplete', { reason: 'max_output_tokens', usage })]);
  assert.equal(finish(chunks).kind, 'max-tokens');
  assert.deepEqual(chunks.at(-2).usage, mappedUsage);
});

for (const reason of ['content_filter', undefined]) {
  test(`non-length incomplete response reports ${reason ?? 'unknown'}`, async () => {
    const chunks = await collect([event('incomplete', { response: { incomplete_details: { reason } } })]);
    assert.equal(finish(chunks).kind, 'error');
    assert.equal(finish(chunks).failure.code, 'INCOMPLETE');
    assert.match(finish(chunks).failure.message, new RegExp(reason ?? 'unknown'));
  });
}

for (const nested of [true, false]) {
  test(`failed response preserves ${nested ? 'nested' : 'legacy'} provider error`, async () => {
    const error = { message: 'Service temporarily unavailable', status: 503 };
    await assert.rejects(collect([event('failed', nested ? { response: { error } } : { error })]),
      e => e.message === error.message && e.code === 'PROVIDER' && e.failure.status === 503);
  });
}

test('standalone error event remains a provider failure', async () => {
  await assert.rejects(collect([{ type: 'error', message: 'No capacity', status: 429 }]),
    e => e.code === 'PROVIDER' && e.message === 'No capacity' && e.failure.status === 429);
});

test('empty completed response uses the harness empty response code', async () => {
  const chunks = await collect([completed]);
  assert.equal(finish(chunks).failure.code, EMPTY_RESPONSE_CODE);
});

test('EOF without a terminal event never fabricates successful completion', async () => {
  await assert.rejects(collect([textDelta('Partial')]), e => e.code === 'STREAM_CLOSED');
  await assert.rejects(collect([]), e => e.code === 'STREAM_CLOSED');
});

test('malformed JSON raises MALFORMED_RESPONSE', async () => {
  await assert.rejects(async () => { for await (const chunk of translate(['{'])) void chunk; },
    e => e.code === 'MALFORMED_RESPONSE');
});

test('conflicting final snapshots cannot silently corrupt text or arguments', async () => {
  await assert.rejects(collect([textDelta('A'), textDone('B'), completed]), e => e.code === 'MALFORMED_RESPONSE');
  await assert.rejects(collect([
    added(call), event('function_call_arguments.delta', { item_id: call.id, delta: 'not JSON' }), done(call), completed,
  ]), e => e.code === 'MALFORMED_RESPONSE');
});

test('completion returns immediately without consuming trailing events', async () => {
  assert.deepEqual(finish(await collect([textDone('A'), completed, { type: 'error', message: 'trailing' }])), { kind: 'stop' });
});
