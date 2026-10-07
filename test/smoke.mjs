/**
 * 端到端冒烟测试:使用真实的 Codex CLI 本地凭证(只读,writeBack: false),
 * 验证 ① 凭证解析 ② 模型目录 ③ 一次真实的流式对话。
 *
 * 运行前提:本仓库目录下存在 node_modules(见 install.ps1 / README 的联调说明),
 * 且 ~/.codex/auth.json 已通过 "codex login" 登录。
 *
 * 用法:node test/smoke.mjs [模型名,默认 gpt-6.1-sol]
 */

import { CodexAdapter } from '../lib/adapter.js';
import { CodexCredentials } from '../lib/auth.js';

const model = process.argv[2] ?? process.env.CODEX_SMOKE_MODEL ?? 'gpt-6.1-sol';
const withTools = process.argv.includes('--tools');
const provider = 'codex';

const config = {
  writeBack: false, // 冒烟测试绝不改写用户的 auth.json
  // clientVersion 走插件默认(constants.js,当前 0.160.1)
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
console.log(`[3] streaming "${model}"${withTools ? ' (with tools)' : ''} …`);
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
          text: withTools ? '用 get_weather 查询北京的天气,不要回答其他内容' : '只回复两个字:你好',
        },
      ],
    },
  ],
  ...(withTools
    ? {
        tools: [
          {
            name: 'get_weather',
            description: '查询城市天气',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        ],
      }
    : {}),
});

let text = '';
let reasoningChars = 0;
let toolCalls = 0;
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

const ok =
  withTools
    ? toolCalls > 0 && finish?.kind === 'tool-calls'
    : typeof text === 'string' && text.trim().length > 0 && finish?.kind === 'stop';
console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED');
process.exit(ok ? 0 : 1);
