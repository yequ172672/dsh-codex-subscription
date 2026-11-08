/**
 * 把 harness 消息序列化为 OpenAI Responses API 的请求体
 * (ChatGPT 订阅后端与官方 API 共用同一 Responses 协议)。
 *
 * 注意:ChatGPT codex 后端拒绝 input 里的 system 角色消息
 * (`{"detail":"System messages are not allowed"}`),系统提示必须放到
 * 顶层 `instructions` 字段 —— 与 ompcn 的 normalizeSystemPrompts 行为一致。
 */

import { createHash } from 'node:crypto';

import { LlmError, contentHasImage } from '@deepseek-ai/dsh-llm';

/** 汇合一条消息中的文本块。 */
function flattenText(blocks) {
  return blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
}

/** 本适配器为文本 only:拒绝图片内容,避免被静默丢弃。 */
function assertTextOnly(blocks) {
  if (contentHasImage(blocks)) {
    throw new LlmError('dsh-llm-codex 适配器暂不支持图片内容。', 'UNSUPPORTED_CONTENT');
  }
  for (const block of blocks) {
    if (block.type === 'tool-result') assertTextOnly(block.content);
  }
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
export function serializeMessages(messages, systemParts) {
  const input = [];
  for (const message of messages) {
    assertTextOnly(message.content);
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
    // user(或混合角色)消息:文本在前,工具结果展开为 function_call_output
    const text = flattenText(message.content);
    if (text.length > 0) {
      input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
    }
    for (const block of message.content) {
      if (block.type !== 'tool-result') continue;
      input.push({
        type: 'function_call_output',
        call_id: normalizeCallId(block.toolCallId),
        output: flattenText(block.content) || '(no output)',
      });
    }
  }
  return input;
}

const WIRE_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/** 把 harness 的 reasoningEffort 映射到 Responses 的 reasoning.effort;none/minimal 原样传递;off/未知 → 不发送(用后端默认)。 */
export function wireEffort(effort) {
  if (effort === undefined || effort === null) return undefined;
  const value = String(effort).toLowerCase();
  if (value === 'off' || value === 'disabled') return undefined;
  return WIRE_EFFORTS.has(value) ? value : undefined;
}

/** 组装完整的 Responses 请求体。 */
export function serializeRequest(options) {
  const systemParts = [];
  if (typeof options.system === 'string' && options.system.length > 0) {
    systemParts.push(options.system);
  }
  const input = serializeMessages(options.messages, systemParts);

  const tools = options.tools?.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  const effort = wireEffort(options.reasoningEffort);

  return {
    model: options.model,
    input,
    stream: true,
    store: false,
    ...(systemParts.length > 0 ? { instructions: systemParts.join('\n\n') } : {}),
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(effort !== undefined ? { reasoning: { effort } } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens }),
    // stop 不是 Responses create 参数,不可沿用 Chat Completions 的字段。
  };
}
