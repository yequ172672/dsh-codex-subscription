/**
 * SSE 解析:把响应字节流切成 data 载荷。
 *
 * 与 chat-completions 不同,Responses 协议没有 [DONE] 哨兵,流的终结由
 * `response.completed` / `response.incomplete` 等事件表达,所以这里只负责
 * 逐条产出 data,不要求也不产生哨兵。
 */

import { EventSourceParserStream } from 'eventsource-parser/stream';

import { toWebStream } from './transport.js';

/** 解析 SSE 字节流为 data 载荷(空行/注释自动跳过)。流自然结束即返回。 */
export async function* parseSse(stream, onComment) {
  const web = toWebStream(stream); // node-fetch 给的是 Node Readable,统一为 Web ReadableStream
  const events = web
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment }));
  for await (const { data } of events) {
    const trimmed = data.trim();
    if (trimmed.length === 0) continue;
    if (trimmed === '[DONE]') {
      yield JSON.stringify({ type: 'response.done' });
      continue;
    }
    yield trimmed;
  }
}
