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

import { CallId, EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm';
import { createProviderError, extractProviderError } from './provider-error.js';

/** 把 wire usage 折成 harness 的 disjoint TokenUsage(cached 从 input 中拆出)。 */
function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const input = nonNegativeNumber(usage.input_tokens);
  const cached = nonNegativeNumber(usage.input_tokens_details?.cached_tokens);
  const reasoning = nonNegativeNumber(usage.output_tokens_details?.reasoning_tokens);
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: nonNegativeNumber(usage.output_tokens),
    ...(cached > 0 ? { cacheReadTokens: Math.min(cached, input) } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/** 收尾一个块,组装最终 ContentBlock。 */
function closeBlock(block) {
  switch (block.kind) {
    case 'reasoning':
      return { type: 'reasoning', text: block.text };
    case 'tool-call':
      return { type: 'tool-call', id: CallId(block.callId ?? ''), name: block.name ?? '', arguments: block.text };
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
export async function* translate(payloads, context = {}) {
  let nextIndex = 0;
  const blocks = new Map(); // key -> block;key = item_id(function_call) | "reasoning:"+item_id | "text:"+item_id
  const order = [];
  let pendingUsage;
  let lastKind; // 最后一个关闭的块类型(text/reasoning/tool-call)
  const stats = { events: 0, started: false, text: false, toolCalls: 0 };
  const errorContext = () => ({
    provider: context.provider ?? 'codex',
    model: context.model,
    diagnostics: {
      ...(context.diagnostics ?? {}),
      streamEvents: stats.events,
      streamStarted: stats.started,
      streamHadText: stats.text,
      streamToolCalls: stats.toolCalls,
    },
  });

  const openBlock = (kind, callId, name) => {
    const block = { index: nextIndex++, kind, text: '', callId, name };
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
      lastKind = block.kind;
      yield { type: 'block-end', index: block.index, block: closeBlock(block) };
    }
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
    stats.events += 1;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      const info = await extractProviderError(payload, errorContext());
      info.code ??= 'INVALID_RESPONSE';
      info.classification = 'INVALID_RESPONSE';
      throw createProviderError(info, 'Codex SSE returned invalid JSON');
    }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
      const info = await extractProviderError(event, errorContext());
      info.code = 'INVALID_RESPONSE';
      info.classification = 'INVALID_RESPONSE';
      throw createProviderError(info, 'Codex SSE returned invalid event');
    }
    if (event.type === 'response.created' || event.type === 'response.in_progress') stats.started = true;
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
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (delta.length === 0) break;
        if (typeof event.item_id !== 'string' || event.item_id.length === 0) {
          const info = await extractProviderError({ type: event.type, code: 'MISSING_ITEM_ID', detail: 'text delta is missing item_id' }, errorContext());
          info.code = 'INVALID_RESPONSE';
          info.classification = 'INVALID_RESPONSE';
          throw createProviderError(info, 'Codex SSE returned invalid text event');
        }
        const key = `text:${event.item_id}`;
        yield* ensureBlock(key, 'text');
        const block = blocks.get(key);
        block.text += delta;
        stats.text = true;
        yield { type: 'text-delta', index: block.index, text: delta };
        break;
      }

      case 'response.reasoning_summary_text.delta': {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (delta.length === 0) break;
        if (typeof event.item_id !== 'string' || event.item_id.length === 0) {
          const info = await extractProviderError({ type: event.type, code: 'MISSING_ITEM_ID', detail: 'reasoning delta is missing item_id' }, errorContext());
          info.code = 'INVALID_RESPONSE';
          info.classification = 'INVALID_RESPONSE';
          throw createProviderError(info, 'Codex SSE returned invalid reasoning event');
        }
        const key = `reasoning:${event.item_id}`;
        yield* ensureBlock(key, 'reasoning');
        const block = blocks.get(key);
        block.text += delta;
        yield { type: 'reasoning-delta', index: block.index, text: delta };
        break;
      }

      case 'response.function_call_arguments.delta': {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        const key = typeof event.item_id === 'string' ? event.item_id : typeof event.call_id === 'string' ? event.call_id : undefined;
        if (key === undefined) {
          const info = await extractProviderError({ type: event.type, code: 'MISSING_ITEM_ID', detail: 'function call delta is missing item_id' }, errorContext());
          info.code = 'INVALID_RESPONSE';
          info.classification = 'INVALID_RESPONSE';
          throw createProviderError(info, 'Codex SSE returned invalid tool event');
        }
        yield* ensureBlock(key, 'tool-call');
        const block = blocks.get(key);
        block.text += delta;
        stats.toolCalls += 1;
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: CallId(block.callId ?? ''),
          ...(block.name !== undefined ? { name: block.name } : {}),
          argumentsDelta: delta,
        };
        break;
      }

      case 'response.output_item.done': {
        const item = event.item;
        if (!item || typeof item !== 'object') break;
        if (item.type === 'function_call') {
          const { callId, name } = functionCallMeta(item);
          const block = blocks.get(item.id);
          if (!block) {
            // 极端情况:无任何 delta 的完整工具调用 → 开块并立即收尾
            yield* ensureBlock(item.id, 'tool-call', callId, name);
            const opened = blocks.get(item.id);
            if (typeof item.arguments === 'string') opened.text = item.arguments;
          } else {
            if (block.callId === undefined && callId !== undefined) block.callId = callId;
            if (block.name === undefined && name !== undefined) block.name = name;
          }
          yield* closeBlocks([item.id]);
        } else if (item.type === 'message') {
          yield* closeBlocks([`reasoning:${item.id}`, `text:${item.id}`]);
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
        yield* finish({ kind: lastKind === 'tool-call' ? 'tool-calls' : 'stop' });
        return;
      }

      case 'response.incomplete': {
        const reason = typeof event.reason === 'string' ? event.reason : undefined;
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
        const info = await extractProviderError(event, errorContext());
        throw createProviderError(info, 'Codex provider error');
      }

      case 'error': {
        const info = await extractProviderError(event, errorContext());
        throw createProviderError(info, 'Codex SSE error');
      }

      default:
        break; // response.created / content_part.* / output_text.done 等忽略
    }
  }

  const info = await extractProviderError({
    message: 'SSE stream ended without a terminal response event',
    code: 'STREAM_CLOSED',
  }, errorContext());
  info.classification = 'STREAM_CLOSED';
  throw createProviderError(info, 'Codex SSE stream closed');
}
