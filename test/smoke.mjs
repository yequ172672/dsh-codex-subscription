/**
 * 端到端冒烟测试:使用真实的 Codex CLI 本地凭证(只读,writeBack: false),
 * 验证 ① 凭证解析 ② 模型目录 ③ 一次真实的流式对话 ④ 工具调用往返(可选)。
 *
 * 运行前提:本仓库目录下存在 node_modules(见 install.ps1 / README 的联调说明),
 * 且 ~/.codex/auth.json 已通过 "codex login" 登录。
 *
 * 用法:node test/smoke.mjs [模型名,默认 gpt-5.6-sol] [--tools] [--roundtrip]
 *   --tools     让模型请求一次工具调用并只校验该请求
 *   --roundtrip 追加第二轮:把 assistant 的 tool-call 与 DSH 0.2 的 role='tool'
 *               结果发回后端,验证 Responses 请求里 function_call 与
 *               function_call_output 正确配对(修复回归的关键用例)
 */

import { CodexAdapter } from '../lib/adapter.js';
import { CodexCredentials } from '../lib/auth.js';

const model = process.argv[2] ?? process.env.CODEX_SMOKE_MODEL ?? 'gpt-5.6-sol';
const withTools = process.argv.includes('--tools');
const roundtrip = process.argv.includes('--roundtrip');
const provider = 'codex';

const config = {
  writeBack: false, // 冒烟测试绝不改写用户的 auth.json
  clientVersion: '0.144.1',
  streamIdleTimeoutMs: 180_000,
};
const credentials = new CodexCredentials(() => config);
const adapter = new CodexAdapter({ options: () => config, credentials });

// ① 凭证解析
const creds = await credentials.current();
console.log(`[1] credential mode = ${creds.mode}` + (creds.mode === 'chatgpt' ? ` (account: ${creds.accountId ?? '?'})` : ''));

// ② 模型目录
const models = await adapter.listModels(provider);
console.log(`[2] model catalog = ${models.length} models`);
console.log('    ' + models.slice(0, 12).map((m) => m.id).join(', '));

// ③ 流式对话(带 maxTokens + reasoningEffort,模拟 DSH 循环的真实请求形状;
// 订阅后端不支持 max_output_tokens,适配器应在发送前剥离)
console.log(`[3] streaming "${model}"${withTools || roundtrip ? ' (with tools)' : ''} …`);
const weatherPrompt = '用 get_weather 查询北京的天气,不要回答其他内容';
const weatherTools = [
  {
    name: 'get_weather',
    description: '查询城市天气',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
];
const stream = adapter.stream({
  provider,
  model,
  system: '你是一个测试助手,回答尽量简短。',
  reasoningEffort: 'max',
  maxTokens: 128000,
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: withTools || roundtrip ? weatherPrompt : '只回复两个字:你好',
        },
      ],
    },
  ],
  ...(withTools || roundtrip ? { tools: weatherTools } : {}),
});

let text = '';
let reasoningChars = 0;
let toolCalls = 0;
let toolCall;
let usage;
let finish;
for await (const chunk of stream) {
  switch (chunk.type) {
    case 'text-delta':
      text += chunk.text;
      process.stdout.write(chunk.text);
      break;
    case 'reasoning-delta':
      reasoningChars += chunk.text.length;
      break;
    case 'tool-call-delta':
      toolCalls += 1;
      toolCall ??= { id: undefined, name: undefined, arguments: '' };
      if (typeof chunk.id === 'string' && chunk.id.length > 0) toolCall.id = chunk.id;
      if (typeof chunk.name === 'string' && chunk.name.length > 0) toolCall.name = chunk.name;
      toolCall.arguments += chunk.argumentsDelta;
      break;
    case 'usage':
      usage = chunk.usage;
      break;
    case 'finish':
      finish = chunk.reason;
      break;
    default:
      break;
  }
}
console.log('');
console.log(`    text=${text.length} chars | reasoning=${reasoningChars} chars | toolCalls=${toolCalls}`);
console.log(`    finish = ${finish?.kind}${finish?.kind === 'error' ? ` (${finish.failure?.message})` : ''}`);
console.log(`    usage  = ${usage ? JSON.stringify(usage) : 'n/a'}`);

// ④ 工具往返:把上一轮的 tool-call 与 DSH 0.2 的 role='tool' 结果一起发回。
// 修复前适配器不认识 role='tool'(当成 user 文本),请求里只有 function_call
// 没有 function_call_output,后端直接 400:No tool output found for function call …
let roundtripOk;
if (roundtrip) {
  if (toolCall?.id === undefined) {
    console.log('[4] 往返未执行:上一轮没有可用的 tool call id');
    roundtripOk = false;
  } else {
    console.log(`[4] tool roundtrip: ${toolCall.name}(${toolCall.arguments}) → role='tool' 结果 …`);
    try {
      const followUp = adapter.stream({
        provider,
        model,
        system: '你是一个测试助手,回答尽量简短。',
        reasoningEffort: 'max',
        maxTokens: 128000,
        messages: [
          { role: 'user', content: [{ type: 'text', text: weatherPrompt }] },
          {
            role: 'assistant',
            content: [{ type: 'tool-call', id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments }],
          },
          {
            role: 'tool',
            toolCallId: toolCall.id,
            content: [{ type: 'text', text: '{"city":"北京","tempC":26,"condition":"晴"}' }],
            isError: false,
          },
        ],
        tools: weatherTools,
      });
      let reply = '';
      let finish4;
      for await (const chunk of followUp) {
        if (chunk.type === 'text-delta') reply += chunk.text;
        else if (chunk.type === 'finish') finish4 = chunk.reason;
      }
      console.log(`     reply  = ${reply.trim().slice(0, 120)}`);
      console.log(`     finish = ${finish4?.kind}${finish4?.kind === 'error' ? ` (${finish4.failure?.message})` : ''}`);
      roundtripOk = finish4?.kind === 'stop' && reply.trim().length > 0;
    } catch (error) {
      console.log(`     ERROR ${error?.message ?? error}`);
      roundtripOk = false;
    }
  }
}

const expectsToolCall = withTools || roundtrip;
const firstTurnOk = expectsToolCall
  ? toolCalls > 0 && finish?.kind === 'tool-calls'
  : typeof text === 'string' && text.trim().length > 0 && finish?.kind === 'stop';
const ok = firstTurnOk && (roundtrip ? roundtripOk === true : true);
console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED');
process.exit(ok ? 0 : 1);
