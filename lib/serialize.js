/**
 * 把 harness 消息序列化为 OpenAI Responses API 的请求体
 * (ChatGPT 订阅后端与官方 API 共用同一 Responses 协议)。
 *
 * 注意:ChatGPT codex 后端拒绝 input 里的 system 角色消息
 * (`{"detail":"System messages are not allowed"}`),系统提示必须放到
 * 顶层 `instructions` 字段 —— 与 ompcn 的 normalizeSystemPrompts 行为一致。
 */

import { createHash } from 'node:crypto';

import { LlmError } from '@deepseek-ai/dsh-llm';

import { applyWireTarget, effectiveWireTarget } from './service-tier.js';

/** 汇合一条消息中的文本块。 */
function flattenText(blocks) {
  return blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
}

/** 递归判断内容是否包含图片。 */
function contentHasImage(blocks) {
  return blocks.some(
    (block) => block.type === 'image' || (block.type === 'tool-result' && contentHasImage(block.content)),
  );
}

/** 图片仅允许出现在 user 消息及其工具结果中。 */
function assertSupportedImageRoles(messages) {
  for (const message of messages) {
    if (message.role !== 'user' && contentHasImage(message.content)) {
      throw new LlmError('dsh-llm-codex 不支持 system 或 assistant 历史消息中的图片。', 'UNSUPPORTED_CONTENT');
    }
  }
}

function collectImageOccurrences(blocks, occurrences) {
  for (const block of blocks) {
    if (block.type === 'image') {
      occurrences.push(block.attachment);
    } else if (block.type === 'tool-result') {
      collectImageOccurrences(block.content, occurrences);
    }
  }
}

function replaceOmittedImages(blocks, omitted, state) {
  return blocks.map((block) => {
    if (block.type === 'image') {
      const index = state.index++;
      return omitted.has(index) ? { type: 'text', text: '[较早图片已省略，以控制本次请求的图片大小。]' } : block;
    }
    if (block.type === 'tool-result') {
      return { ...block, content: replaceOmittedImages(block.content, omitted, state) };
    }
    return block;
  });
}

function projectOmittedImages(messages, omitted) {
  const state = { index: 0 };
  return messages.map((message) => ({ ...message, content: replaceOmittedImages(message.content, omitted, state) }));
}

function base64Length(byteLength) {
  return Math.ceil(byteLength / 3) * 4;
}

function attachmentKey(ref) {
  return ref?.attachmentId ?? ref?.id ?? JSON.stringify(ref);
}

/**
 * 计算 DSH 0.2 AttachmentStore 所需的请求图片投影目标。附件服务不接收
 * maxPixels，而是接收保持纵横比的具体尺寸和编码字节目标。
 */
function requestImageTarget(ref, config) {
  const sourceWidth = Number(ref?.width);
  const sourceHeight = Number(ref?.height);
  if (!Number.isFinite(sourceWidth) || sourceWidth < 1 || !Number.isFinite(sourceHeight) || sourceHeight < 1) {
    throw new LlmError('dsh-llm-codex 图片附件缺少有效尺寸。', 'UNSUPPORTED_CONTENT');
  }
  const width = sourceWidth;
  const height = sourceHeight;
  const maxPixels = Number(config?.requestImagePixelBudget ?? 2048 * 2048);
  if (!Number.isFinite(maxPixels) || maxPixels < 1) {
    throw new LlmError('dsh-llm-codex 图片请求像素预算无效。', 'UNSUPPORTED_CONTENT');
  }
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  let projectedWidth = Math.max(1, Math.floor(width * scale));
  let projectedHeight = Math.max(1, Math.round(projectedWidth * height / width));
  if (height > width) {
    projectedHeight = Math.max(1, Math.floor(height * scale));
    projectedWidth = Math.max(1, Math.round(projectedHeight * width / height));
  }
  while (projectedWidth * projectedHeight > maxPixels) {
    if (width >= height && projectedWidth > 1) {
      projectedWidth -= 1;
      projectedHeight = Math.max(1, Math.round(projectedWidth * height / width));
    } else if (projectedHeight > 1) {
      projectedHeight -= 1;
      projectedWidth = Math.max(1, Math.round(projectedHeight * width / height));
    } else {
      break;
    }
  }
  return {
    width: projectedWidth,
    height: projectedHeight,
    maxBytes: Number(config?.requestImageMaxBytes ?? 1024 * 1024),
  };
}

/**
 * 读取并裁剪本次请求需要的图片。历史图片按时间从旧到新保留，超限时先
 * 用占位文本替换较早图片；不会修改 session 中的原始消息对象。
 */
async function prepareImages(messages, attachments, config, signal) {
  const occurrences = [];
  for (const message of messages) collectImageOccurrences(message.content, occurrences);
  if (occurrences.length === 0) return { messages, images: new Map() };

  if (!attachments || typeof attachments.readImageRequest !== 'function') {
    throw new LlmError('dsh-llm-codex 图片输入需要 DSH 附件服务。', 'UNSUPPORTED_CONTENT');
  }

  const maxRequestBytes = config?.maxRequestImageBytes ?? 20 * 1024 * 1024;
  const omitted = new Set();
  let estimatedBytes = 0;
  for (let index = occurrences.length - 1; index >= 0; index -= 1) {
    const ref = occurrences[index];
    const estimated = base64Length(Number.isFinite(ref?.bytes) ? ref.bytes : 0);
    if (estimated > 0 && estimatedBytes + estimated > maxRequestBytes && index !== occurrences.length - 1) {
      omitted.add(index);
      continue;
    }
    estimatedBytes += estimated;
  }

  const projectedMessages = projectOmittedImages(messages, omitted);
  const projectedRefs = [];
  for (const message of projectedMessages) collectImageOccurrences(message.content, projectedRefs);
  const images = new Map();
  for (const ref of projectedRefs) {
    const key = attachmentKey(ref);
    if (images.has(key)) continue;
    try {
      const version = await attachments.readImageRequest(
        ref,
        requestImageTarget(ref, config),
        signal,
      );
      if (!version || !(version.data instanceof Uint8Array) || typeof version.mediaType !== 'string') {
        throw new Error('invalid image attachment response');
      }
      images.set(key, version);
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw error;
      if (error instanceof LlmError) throw error;
      throw new LlmError('dsh-llm-codex 无法读取图片附件。', 'UNSUPPORTED_CONTENT', { cause: error });
    }
  }
  return { messages: projectedMessages, images };
}

function serializeImage(block, images) {
  const version = images.get(attachmentKey(block.attachment));
  if (!version) throw new LlmError('dsh-llm-codex 图片附件未能读取。', 'UNSUPPORTED_CONTENT');
  const data = Buffer.from(version.data).toString('base64');
  return {
    type: 'input_image',
    detail: 'auto',
    image_url: `data:${version.mediaType};base64,${data}`,
  };
}

function serializeInputContent(blocks, images) {
  const content = [];
  for (const block of blocks) {
    if (block.type === 'text') content.push({ type: 'input_text', text: block.text });
    else if (block.type === 'image') content.push(serializeImage(block, images));
    else if (block.type === 'tool-result') content.push(...serializeInputContent(block.content, images));
  }
  return content;
}

function serializeToolOutput(blocks, images) {
  const content = serializeInputContent(blocks, images);
  if (content.some((block) => block.type === 'input_image')) return content;
  return flattenText(blocks) || '(no output)';
}

function countBlocks(blocks, predicate) {
  let count = 0;
  for (const block of blocks ?? []) {
    if (predicate(block)) count += 1;
    if (block.type === 'tool-result') count += countBlocks(block.content, predicate);
  }
  return count;
}

function textLength(value) {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + textLength(item), 0);
  if (value && typeof value === 'object') {
    return Object.entries(value).reduce((sum, [key, item]) => sum + (key === 'text' || key === 'output' || key === 'arguments' ? textLength(item) : 0), 0);
  }
  return 0;
}

/**
 * Stringify a provider request without exposing the request body when V8
 * rejects it (for example because a caller supplied a circular value or
 * BigInt). The caller receives a stable, actionable serialization error.
 */
export function stringifyRequestBody(body, field = 'request body') {
  try {
    const payload = JSON.stringify(body);
    if (typeof payload !== 'string') throw new TypeError('JSON.stringify returned no string');
    return payload;
  } catch (error) {
    let reason;
    try {
      reason = String(error?.message ?? error).replace(/[\r\n\t ]+/g, ' ').slice(0, 240);
    } catch {
      reason = 'unknown serialization error';
    }
    reason = reason.replace(/(?:Bearer\s+|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie|prompt|messages|tool[_-]?result)\s*[:=]?\s*[^\s;]+/gi, '[REDACTED]');
    throw new LlmError(`Codex request serialization failed; field=${field}; reason=${reason || 'unknown serialization error'}`, 'INVALID_REQUEST', { cause: error });
  }
}

/** Build bounded request facts for an error message; never includes request content. */
export function requestDiagnostics(options, body, payload, config) {
  const originalImages = (options?.messages ?? []).reduce(
    (sum, message) => sum + countBlocks(message.content, (block) => block.type === 'image'),
    0,
  );
  const serializedImages = (body?.input ?? []).reduce(
    (sum, item) => sum + countBlocks(item.content, (block) => block.type === 'input_image'),
    0,
  );
  let largestToolResultChars = 0;
  let totalToolResultChars = 0;
  for (const item of body?.input ?? []) {
    if (item?.type !== 'function_call_output') continue;
    const length = textLength(item.output);
    largestToolResultChars = Math.max(largestToolResultChars, length);
    totalToolResultChars += length;
  }
  return {
    pickerModel: typeof options?.model === 'string' ? options.model : undefined,
    wireModel: typeof body?.model === 'string' ? body.model : undefined,
    requestedServiceTier: body?.service_tier,
    model: typeof options?.model === 'string' ? options.model : undefined,
    requestBytes: typeof payload === 'string' ? Buffer.byteLength(payload, 'utf8') : undefined,
    inputItems: Array.isArray(body?.input) ? body.input.length : undefined,
    messageCount: Array.isArray(options?.messages) ? options.messages.length : undefined,
    toolCount: Array.isArray(body?.tools) ? body.tools.length : 0,
    largestToolResultChars,
    totalToolResultChars,
    hasImages: originalImages > 0,
    imageCount: originalImages,
    imagesCropped: Math.max(0, originalImages - serializedImages),
    contextWindow: options?.contextWindow ?? config?.contextWindow,
    reasoning: body?.reasoning !== undefined,
    reasoningEffort: body?.reasoning?.effort,
    maxOutputTokens: body?.max_output_tokens,
  };
}

/** Responses API call_id 的协议上限。 */
const MAX_CALL_ID_LENGTH = 64;

/**
 * 将任意 provider 的工具调用 ID 映射为 Responses API 接受的稳定 ID。
 * 64 字符以内且只含协议字符的 ID 原样保留;其余 ID 使用 SHA-256,
 * 保证 function_call 与 function_call_output 对同一历史 ID 得到相同结果。
 */
export function normalizeCallId(value) {
  const id = String(value);
  if (id.length > 0 && id.length <= MAX_CALL_ID_LENGTH && /^[a-zA-Z0-9_-]+$/.test(id)) return id;
  const digestLength = MAX_CALL_ID_LENGTH - 'call_'.length;
  return `call_${createHash('sha256').update(id).digest('hex').slice(0, digestLength)}`;
}

/**
 * 将 harness 消息列表序列化为 Responses API 的 input 项。
 * system 消息不进入 input,而是收集进 `systemParts`(由调用方放到 instructions)。
 */
export async function serializeMessages(messages, systemParts, attachments, config, signal) {
  assertSupportedImageRoles(messages);
  const prepared = await prepareImages(messages, attachments, config, signal);
  const input = [];
  for (const message of prepared.messages) {
    if (message.role === 'system') {
      const text = flattenText(message.content);
      if (text.length > 0) systemParts.push(text);
      continue;
    }
    if (message.role === 'assistant') {
      const text = flattenText(message.content);
      if (text.length > 0) {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      }
      for (const block of message.content) {
        if (block.type !== 'tool-call') continue;
        input.push({
          type: 'function_call',
          call_id: normalizeCallId(block.id),
          name: block.name,
          arguments: block.arguments,
        });
      }
      continue;
    }
    // user(或混合角色)消息:文本/图片在前,工具结果展开为 function_call_output
    const content = serializeInputContent(message.content.filter((block) => block.type !== 'tool-result'), prepared.images);
    if (content.length > 0) input.push({ type: 'message', role: 'user', content });
    for (const block of message.content) {
      if (block.type !== 'tool-result') continue;
      input.push({
        type: 'function_call_output',
        call_id: normalizeCallId(block.toolCallId),
        output: serializeToolOutput(block.content, prepared.images),
      });
    }
  }
  return input;
}

const WIRE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/** 把 harness 的 reasoningEffort 映射到 Responses 的 reasoning.effort;off/未知 → 不发送(用后端默认)。 */
export function wireEffort(effort) {
  if (effort === undefined || effort === null) return undefined;
  const value = String(effort).toLowerCase();
  if (value === 'off' || value === 'none' || value === 'disabled') return undefined;
  return WIRE_EFFORTS.has(value) ? value : undefined;
}

/** 组装完整的 Responses 请求体。 */
export async function serializeRequest(options, attachments, config, signal) {
  const systemParts = [];
  if (typeof options.system === 'string' && options.system.length > 0) {
    systemParts.push(options.system);
  }
  const input = await serializeMessages(options.messages, systemParts, attachments, config, signal);

  const tools = options.tools?.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  const effort = wireEffort(options.reasoningEffort);

  const target = effectiveWireTarget(options.model, options.purpose);
  return applyWireTarget({
    model: options.model,
    input,
    stream: true,
    store: false,
    ...(systemParts.length > 0 ? { instructions: systemParts.join('\n\n') } : {}),
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(effort !== undefined ? { reasoning: { effort } } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens }),
    ...(options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {}),
  }, target);
}
