import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeCallId, serializeMessages, serializeRequest, wireEffort } from '../lib/serialize.js';

function pairedCallIds(id) {
  const messages = [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id, name: 'run_code', arguments: '{}' }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool-result',
          toolCallId: id,
          content: [{ type: 'text', text: 'ok' }],
        },
      ],
    },
  ];
  return serializeMessages(messages, [])
    .filter((item) => Object.hasOwn(item, 'call_id'))
    .map((item) => item.call_id);
}

test('normalizes foreign history call IDs for Responses API replay', () => {
  const longId =
    'call_ff5c0df8e42749068c868bd1|fc_02178672417344200000000000000000000ffffac174e11519098';
  const neighborId =
    'call_ff5c0df8e42749068c868bd1|fc_12178672417344200000000000000000000ffffac174e11519098';

  const [callId, resultCallId] = pairedCallIds(longId);
  assert.equal(callId, resultCallId);
  assert.equal(callId.length, 64);
  assert.match(callId, /^[a-zA-Z0-9_-]+$/);
  assert.notEqual(callId, normalizeCallId(neighborId));
});

test('preserves already valid Responses API call IDs', () => {
  const id = 'call_abc-123_XYZ';
  assert.deepEqual(pairedCallIds(id), [id, id]);
});

test('normalizes forbidden call ID characters deterministically', () => {
  const id = 'provider/call+id=with|punctuation';
  const normalized = normalizeCallId(id);
  assert.equal(normalized, normalizeCallId(id));
  assert.equal(normalized.length, 64);
  assert.match(normalized, /^[a-zA-Z0-9_-]+$/);
});


test('preserves supported model-specific reasoning efforts without guessing a replacement', () => {
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    assert.equal(wireEffort(effort), effort);
    assert.equal(serializeRequest({ model: 'fixture-model', messages: [], reasoningEffort: effort }).reasoning.effort, effort);
  }
  for (const effort of [undefined, null, 'off', 'disabled', 'unknown']) assert.equal(wireEffort(effort), undefined);
});

test('does not send the Chat Completions-only stop parameter', () => {
  const body = serializeRequest({ model: 'fixture-model', messages: [], stop: ['stop'] });
  assert.equal(Object.hasOwn(body, 'stop'), false);
});

test('rejects image content inside tool results instead of silently dropping it', () => {
  const messages = [{ role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'image', data: 'fixture-image', mimeType: 'image/png' }] }] }];
  assert.throws(() => serializeMessages(messages, []), error => error.code === 'UNSUPPORTED_CONTENT');
});
