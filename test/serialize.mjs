import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeCallId, requestDiagnostics, serializeMessages, serializeRequest, stringifyRequestBody } from '../lib/serialize.js';
import { applyWireTarget, parsePickerModelId, resolveWireModel } from '../lib/service-tier.js';

async function pairedCallIds(id) {
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
  return (await serializeMessages(messages, []))
    .filter((item) => Object.hasOwn(item, 'call_id'))
    .map((item) => item.call_id);
}

test('maps picker ids to wire ids and service tiers without leaking synthetic ids', () => {
  assert.deepEqual(parsePickerModelId('gpt-5.6-luna'), { wireId: 'gpt-5.6-luna', fast: false });
  assert.deepEqual(resolveWireModel('gpt-5.6-luna'), { wireId: 'gpt-5.6-luna' });
  assert.deepEqual(resolveWireModel('gpt-5.6-luna-fast'), { wireId: 'gpt-5.6-luna', serviceTier: 'priority' });
  assert.deepEqual(resolveWireModel('unknown'), { wireId: 'unknown' });
  assert.deepEqual(resolveWireModel('unknown-fast'), { wireId: 'unknown', serviceTier: 'priority' });
  assert.deepEqual(parsePickerModelId('model-fast-fast'), { wireId: 'model-fast', fast: true });
  const original = { model: 'picker-fast', input: [] };
  const projected = applyWireTarget(original, { wireId: 'picker', serviceTier: 'priority' });
  assert.deepEqual(projected, { model: 'picker', input: [], service_tier: 'priority' });
  assert.deepEqual(original, { model: 'picker-fast', input: [] });
});

test('serializes ordinary and Fast models with purpose-safe wire fields', async () => {
  const options = {
    model: 'gpt-5.6-luna-fast',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  };
  const fast = await serializeRequest(options);
  assert.equal(fast.model, 'gpt-5.6-luna');
  assert.equal(fast.service_tier, 'priority');
  assert.equal(fast.model.includes('-fast'), false);
  const compact = await serializeRequest({ ...options, purpose: 'compaction' });
  assert.deepEqual({ model: compact.model, service_tier: compact.service_tier }, { model: 'gpt-5.6-luna', service_tier: undefined });
  const ordinary = await serializeRequest({ ...options, model: 'gpt-5.6-luna' });
  assert.equal(ordinary.model, 'gpt-5.6-luna');
  assert.equal(Object.hasOwn(ordinary, 'service_tier'), false);
});

test('request diagnostics expose tier facts without request contents', () => {
  const body = { model: 'gpt-5.6-luna', service_tier: 'priority', input: [{ content: [{ type: 'input_text', text: 'secret prompt' }] }] };
  const facts = requestDiagnostics({ model: 'gpt-5.6-luna-fast', messages: [{ content: [{ type: 'text', text: 'secret prompt' }] }] }, body, JSON.stringify(body));
  assert.equal(facts.pickerModel, 'gpt-5.6-luna-fast');
  assert.equal(facts.wireModel, 'gpt-5.6-luna');
  assert.equal(facts.requestedServiceTier, 'priority');
  assert.equal(Object.hasOwn(facts, 'input'), false);
  assert.equal(Object.hasOwn(facts, 'prompt'), false);
});

test('normalizes foreign history call IDs for Responses API replay', async () => {
  const longId =
    'call_ff5c0df8e42749068c868bd1|fc_02178672417344200000000000000000000ffffac174e11519098';
  const neighborId =
    'call_ff5c0df8e42749068c868bd1|fc_12178672417344200000000000000000000ffffac174e11519098';

  const [callId, resultCallId] = await pairedCallIds(longId);
  assert.equal(callId, resultCallId);
  assert.equal(callId.length, 64);
  assert.match(callId, /^[a-zA-Z0-9_-]+$/);
  assert.notEqual(callId, normalizeCallId(neighborId));
});

test('preserves already valid Responses API call IDs', async () => {
  const id = 'call_abc-123_XYZ';
  assert.deepEqual(await pairedCallIds(id), [id, id]);
});

test('normalizes forbidden call ID characters deterministically', () => {
  const id = 'provider/call+id=with|punctuation';
  const normalized = normalizeCallId(id);
  assert.equal(normalized, normalizeCallId(id));
  assert.equal(normalized.length, 64);
  assert.match(normalized, /^[a-zA-Z0-9_-]+$/);
});

test('projects large images to DSH 0.2 width and height targets', async () => {
  const attachment = {
    attachmentId: 'large-image',
    mediaType: 'image/png',
    bytes: 100,
    width: 4000,
    height: 2000,
  };
  let policy;
  await serializeMessages(
    [{ role: 'user', content: [{ type: 'image', attachment }] }],
    [],
    { readImageRequest: async (_ref, target) => { policy = target; return { ...attachment, data: new Uint8Array([1]) }; } },
    { requestImagePixelBudget: 1_000_000, requestImageMaxBytes: 500_000 },
  );
  assert.deepEqual(policy, { width: 1414, height: 707, maxBytes: 500_000 });
});

test('serializes user images as Responses input_image blocks', async () => {
  const attachment = {
    attachmentId: 'sha256:image-1',
    mediaType: 'image/png',
    bytes: 3,
    width: 1000,
    height: 500,
  };
  const attachments = {
    async readImageRequest(ref, policy, signal) {
      assert.equal(ref, attachment);
      assert.deepEqual(policy, { width: 1000, height: 500, maxBytes: 1048576 });
      assert.equal(signal.aborted, false);
      return { ...attachment, data: new Uint8Array([1, 2, 3]) };
    },
  };

  const result = await serializeMessages(
    [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', attachment }] }],
    [],
    attachments,
    { requestImagePixelBudget: 4194304, requestImageMaxBytes: 1048576 },
    new AbortController().signal,
  );

  assert.deepEqual(result[0].content, [
    { type: 'input_text', text: '看图' },
    { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,AQID' },
  ]);
});

test('rejects image input when the optional attachment service is unavailable', async () => {
  await assert.rejects(
    serializeMessages([{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'missing' } }] }], []),
    (error) => error.code === 'UNSUPPORTED_CONTENT',
  );
});

test('rejects images in assistant history', async () => {
  await assert.rejects(
    serializeMessages(
      [{ role: 'assistant', content: [{ type: 'image', attachment: { attachmentId: 'assistant-image' } }] }],
      [],
    ),
    (error) => error.code === 'UNSUPPORTED_CONTENT',
  );
});

test('offloads older images without mutating the source messages', async () => {
  const oldImage = Object.freeze({ attachmentId: 'old', mediaType: 'image/png', bytes: 9, width: 10, height: 10 });
  const currentImage = Object.freeze({ attachmentId: 'current', mediaType: 'image/jpeg', bytes: 3, width: 10, height: 10 });
  const messages = Object.freeze([
    Object.freeze({ role: 'user', content: Object.freeze([{ type: 'image', attachment: oldImage }]) }),
    Object.freeze({ role: 'user', content: Object.freeze([{ type: 'image', attachment: currentImage }]) }),
  ]);
  const read = [];
  const attachments = {
    async readImageRequest(ref) {
      read.push(ref.attachmentId);
      return { ...ref, data: new Uint8Array([1]), mediaType: ref.mediaType };
    },
  };

  const result = await serializeMessages(messages, [], attachments, { maxRequestImageBytes: 8 });
  assert.deepEqual(read, ['current']);
  assert.deepEqual(result[0].content, [
    { type: 'input_text', text: '[较早图片已省略，以控制本次请求的图片大小。]' },
  ]);
  assert.equal(result[1].content[0].type, 'input_image');
  assert.equal(messages[0].content[0].type, 'image');
});

test('reports safe request serialization failures without body contents', () => {
  const circular = {};
  circular.self = circular;
  assert.throws(() => stringifyRequestBody(circular), (error) => {
    assert.equal(error.code, 'INVALID_REQUEST');
    assert.match(error.message, /serialization failed/);
    assert.doesNotMatch(error.message, /complete|request body contents/i);
    return true;
  });
});

test('serializes images nested in tool results', async () => {
  const attachment = { attachmentId: 'tool-image', mediaType: 'image/webp', bytes: 2, width: 1, height: 1 };
  const result = await serializeMessages(
    [
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_tool',
            content: [{ type: 'text', text: '截图' }, { type: 'image', attachment }],
          },
        ],
      },
    ],
    [],
    { readImageRequest: async () => ({ ...attachment, data: new Uint8Array([255]) }) },
  );
  assert.deepEqual(result[0].output, [
    { type: 'input_text', text: '截图' },
    { type: 'input_image', detail: 'auto', image_url: 'data:image/webp;base64,/w==' },
  ]);
});
