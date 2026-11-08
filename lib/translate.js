/**
 * 把 Responses API 的 SSE 事件流翻译为 harness StreamChunk。
 *
 * 事件词汇(ChatGPT 订阅后端与官方 Responses API 一致):
 * - response.output_item.added / .done
 * - response.output_text.delta / .done
 * - response.refusal.delta
 * - response.reasoning_summary_text.delta / .done
 * - response.function_call_arguments.delta / .done
 * - response.completed / response.done / response.incomplete / response.failed
 * - response.usage / error
 *
 * 块(block)规则:推理、正文、工具调用各占一个独立块;块按首次 delta 惰性
 * 打开,在 output_item.done 或终结事件时收尾。usage 与 finish 永远最后发出。
 */

import { LlmError, ToolCallId, EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm';

/** 把 wire usage 折成 harness 的 disjoint TokenUsage(cached 从 input 中拆出)。 */
export function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const cached = usage.input_tokens_details?.cached_tokens;
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  return {
    inputTokens: (usage.input_tokens ?? 0) - (typeof cached === 'number' ? cached : 0),
    outputTokens: usage.output_tokens ?? 0,
    ...(typeof cached === 'number' ? { cacheReadTokens: cached } : {}),
    ...(typeof reasoning === 'number' ? { reasoningTokens: reasoning } : {}),
  };
}

/** 收尾一个块,组装最终 ContentBlock。 */
function closeBlock(block) {
  switch (block.kind) {
    case 'reasoning':
      return { type: 'reasoning', text: block.text };
    case 'tool-call':
      return { type: 'tool-call', id: ToolCallId(block.callId ?? ''), name: block.name ?? '', arguments: block.text };
    case 'text':
    default:
      return { type: 'text', text: block.text };
  }
}

/** 从输出项里提取 function_call 的 call_id/name。 */
function functionCallMeta(item) {
  if (!item || typeof item !== 'object') return { callId: undefined, name: undefined };
  return {
    callId: typeof item.call_id === 'string' ? item.call_id : undefined,
    name: typeof item.name === 'string' ? item.name : undefined,
  };
}

/**
 * 消费 SSE data 载荷并产出 StreamChunk。
 * @param payloads - parseSse 产出的 JSON 载荷(自然结束,无 [DONE])。
 */
export async function* translate(payloads) {
  let nextIndex = 0;
  const blocks = new Map(); // key -> block;key = item_id(function_call) | "reasoning:"+item_id | "text:"+item_id
  const order = [];
  let pendingUsage;

  const openBlock = (kind, callId, name) => {
    const block = { index: nextIndex++, kind, text: '', callId, name, parts: new Map() };
    order.push(block);
    return block;
  };

  /** 取 key 对应的块;没有则惰性打开并先发 block-start。 */
  const ensureBlock = function* (key, kind, callId, name) {
    let block = blocks.get(key);
    if (!block) {
      block = openBlock(kind, callId, name);
      blocks.set(key, block);
      yield { type: 'block-start', index: block.index, blockType: kind };
    }
    return block;
  };

  /** 关闭指定 keys 的块并逐个发 block-end。 */
  const closeBlocks = function* (keys) {
    for (const key of keys) {
      const block = blocks.get(key);
      if (!block) continue;
      blocks.delete(key);
      yield { type: 'block-end', index: block.index, block: closeBlock(block) };
    }
  };

  // done 载荷是完整快照,不能直接追加,否则会重复已有 delta。
  // 按内容/摘要索引记录已接收文本,避免多个 part 相互覆盖。
  const appendText = function* (key, kind, partIndex, text, snapshot = false) {
    if (typeof text !== 'string' || text.length === 0) return;
    const block = yield* ensureBlock(key, kind);
    const previous = block.parts.get(partIndex) ?? '';
    if (snapshot && !text.startsWith(previous)) {
      throw new LlmError('SSE text snapshot conflicts with streamed content', 'MALFORMED_RESPONSE');
    }
    const delta = snapshot ? text.slice(previous.length) : text;
    block.parts.set(partIndex, snapshot ? text : previous + text);
    block.text += delta;
    if (delta) yield { type: kind === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: block.index, text: delta };
  };

  const appendArguments = function* (block, text, snapshot = false) {
    if (typeof text !== 'string') return;
    if (snapshot && !text.startsWith(block.text)) {
      throw new LlmError('SSE arguments snapshot conflicts with streamed content', 'MALFORMED_RESPONSE');
    }
    const delta = snapshot ? text.slice(block.text.length) : text;
    block.text += delta;
    if (delta) yield {
      type: 'tool-call-delta', index: block.index,
      id: ToolCallId(block.callId ?? ''),
      ...(block.name !== undefined ? { name: block.name } : {}),
      argumentsDelta: delta,
    };
  };

  /** 终结流程:关闭所有剩余块 → usage → finish(顺序固定)。 */
  const finish = function* (reason) {
    yield* closeBlocks([...blocks.keys()]);
    if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage };
    if (reason.kind === 'stop' && order.length === 0) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
        },
      };
    } else {
      yield { type: 'finish', reason };
    }
  };

  for await (const payload of payloads) {
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE');
    }
    switch (event.type) {
      case 'response.output_item.added': {
        const item = event.item;
        if (!item || typeof item !== 'object') break;
        if (item.type === 'function_call') {
          // 工具调用在 item 建立时开块(call_id/name 已知);arguments 由后续 delta 填充
          const { callId, name } = functionCallMeta(item);
          yield* ensureBlock(item.id, 'tool-call', callId, name);
        }
        // message 项不在此处开块:等第一个 delta 惰性打开,避免空块
        break;
      }

      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        yield* appendText(`text:${event.item_id}`, 'text', event.content_index ?? 0, event.delta);
        break;
      }

      case 'response.output_text.done':
      case 'response.refusal.done': {
        yield* appendText(`text:${event.item_id}`, 'text', event.content_index ?? 0,
          event.type === 'response.refusal.done' ? event.refusal : event.text, true);
        break;
      }

      case 'response.reasoning_summary_text.delta': {
        yield* appendText(`reasoning:${event.item_id}`, 'reasoning', event.summary_index ?? 0, event.delta);
        break;
      }

      case 'response.reasoning_summary_text.done': {
        yield* appendText(`reasoning:${event.item_id}`, 'reasoning', event.summary_index ?? 0, event.text, true);
        break;
      }

      case 'response.function_call_arguments.delta': {
        const key = event.item_id;
        const block = yield* ensureBlock(key, 'tool-call');
        yield* appendArguments(block, event.delta);
        break;
      }

      case 'response.function_call_arguments.done': {
        const block = yield* ensureBlock(event.item_id, 'tool-call');
        yield* appendArguments(block, event.arguments, true);
        break;
      }

      case 'response.output_item.done': {
        const item = event.item;
        if (!item || typeof item !== 'object') break;
        if (item.type === 'function_call') {
          const { callId, name } = functionCallMeta(item);
          const block = yield* ensureBlock(item.id, 'tool-call', callId, name);
          if (callId !== undefined) block.callId = callId;
          if (name !== undefined) block.name = name;
          yield* appendArguments(block, item.arguments, true);
          yield* closeBlocks([item.id]);
        } else if (item.type === 'message') {
          for (const [index, part] of (item.content ?? []).entries()) {
            if (part.type === 'output_text' || part.type === 'refusal') {
              yield* appendText(`text:${item.id}`, 'text', index,
                part.type === 'refusal' ? part.refusal : part.text, true);
            }
          }
          yield* closeBlocks([`text:${item.id}`]);
        } else if (item.type === 'reasoning') {
          for (const [index, part] of (item.summary ?? []).entries()) {
            if (part.type === 'summary_text') {
              yield* appendText(`reasoning:${item.id}`, 'reasoning', index, part.text, true);
            }
          }
          yield* closeBlocks([`reasoning:${item.id}`]);
        }
        break;
      }

      case 'response.usage': {
        const mapped = mapUsage(event.usage);
        if (mapped !== undefined) pendingUsage = mapped;
        break;
      }

      case 'response.completed':
      case 'response.done': {
        const mapped = mapUsage(event.usage ?? event.response?.usage);
        if (mapped !== undefined) pendingUsage = mapped;
        yield* finish({ kind: order.some(block => block.kind === 'tool-call') ? 'tool-calls' : 'stop' });
        return;
      }

      case 'response.incomplete': {
        const mapped = mapUsage(event.usage ?? event.response?.usage);
        if (mapped !== undefined) pendingUsage = mapped;
        const reason = event.response?.incomplete_details?.reason ?? event.reason;
        yield* finish(
          reason === 'max_output_tokens'
            ? { kind: 'max-tokens' }
            : {
                kind: 'error',
                failure: { message: `response incomplete: ${reason ?? 'unknown'}`, code: 'INCOMPLETE' },
              },
        );
        return;
      }

      case 'response.failed': {
        const error = event.response?.error ?? event.error;
        throw new LlmError(
          error?.message ?? 'response failed',
          'PROVIDER',
          typeof error?.status === 'number' ? { status: error.status } : {},
        );
      }

      case 'error': {
        throw new LlmError(
          typeof event.message === 'string' ? event.message : 'provider error',
          'PROVIDER',
          typeof event.status === 'number' ? { status: event.status } : {},
        );
      }

      default:
        break; // response.created / content_part.* 等忽略
    }
  }

  throw new LlmError('SSE stream ended without a terminal response event', 'STREAM_CLOSED');
}
