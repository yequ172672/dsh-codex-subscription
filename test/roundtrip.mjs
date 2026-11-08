import assert from 'node:assert/strict';
import { createLiveAdapter } from './live-support.mjs';

const model = process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? process.env.CODEX_SMOKE_MODEL ?? 'gpt-6.1-sol';
const { adapter, catalog } = await createLiveAdapter();
assert.ok(catalog.some(item => item.id === model), 'requested model must appear in the live catalog');
const effort = process.env.CODEX_SMOKE_EFFORT ?? 'low';
const tools = [{ name: 'add_numbers', description: 'Add two small integers. Use this tool for the requested sum.', parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'], additionalProperties: false } }];
const messages = [{ role: 'user', content: [{ type: 'text', text: 'Call add_numbers with a=2 and b=3 exactly once. After the tool result, answer only the sum.' }] }];
const run = async history => {
  const blocks = [];
  let finish, usage;
  for await (const chunk of adapter.stream({ provider: 'codex', model, reasoningEffort: effort, system: 'You are a small integration test. Follow the user instruction exactly.', messages: history, tools })) {
    if (chunk.type === 'block-end') blocks.push(chunk.block);
    if (chunk.type === 'finish') finish = chunk.reason;
    if (chunk.type === 'usage') usage = chunk.usage;
  }
  return { blocks, finish, usage };
};
const first = await run(messages);
assert.equal(first.finish?.kind, 'tool-calls');
const calls = first.blocks.filter(block => block.type === 'tool-call');
assert.equal(calls.length, 1);
assert.equal(calls[0].name, 'add_numbers');
const args = JSON.parse(calls[0].arguments);
assert.deepEqual(args, { a: 2, b: 3 });
messages.push({ role: 'assistant', content: first.blocks });
messages.push({ role: 'user', content: [{ type: 'tool-result', toolCallId: calls[0].id, content: [{ type: 'text', text: String(args.a + args.b) }] }] });
const second = await run(messages);
assert.equal(second.finish?.kind, 'stop');
const text = second.blocks.filter(block => block.type === 'text').map(block => block.text).join('').trim();
assert.match(text, /^5[.!。]?$/);
console.log(JSON.stringify({ result: 'ROUNDTRIP OK', model, liveModels: catalog.length, toolCalls: calls.length, answer: text, firstUsage: first.usage, secondUsage: second.usage }));
