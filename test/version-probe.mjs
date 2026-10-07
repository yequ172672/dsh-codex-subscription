/**
 * 只读协议探针(消耗极少订阅额度):
 *  ① 不同 client_version 下 GET /codex/models 的目录差异(服务端是否按版本门控)
 *  ② 用指定 version + model 发一条最小流式对话,验证 wire 头是否被接受
 * 用法: node test/version-probe.mjs [clientVersion] [model]
 */

import { CodexAdapter } from '../lib/adapter.js';
import { CodexCredentials } from '../lib/auth.js';
import { createTransport } from '../lib/transport.js';
import { CHATGPT_BASE_URL, CODEX_HEADERS, CODEX_HEADER_VALUES } from '../lib/constants.js';

const probeVersion = process.argv[4] ?? '0.160.1';
const streamVersion = process.argv[2] ?? '0.160.1';
const model = process.argv[3] ?? 'gpt-6.1-sol';

const config = { writeBack: false, clientVersion: streamVersion, streamIdleTimeoutMs: 120_000 };
const credentials = new CodexCredentials(() => config);
const creds = await credentials.current();
const transport = await createTransport({});

for (const v of ['0.144.1', probeVersion]) {
  const url = new URL(`${CHATGPT_BASE_URL}/codex/models`);
  url.searchParams.set('client_version', v);
  const headers = {
    authorization: `Bearer ${creds.accessToken}`,
    accept: 'application/json',
    [CODEX_HEADERS.BETA]: CODEX_HEADER_VALUES.BETA_RESPONSES,
    [CODEX_HEADERS.ORIGINATOR]: CODEX_HEADER_VALUES.ORIGINATOR,
    [CODEX_HEADERS.VERSION]: v,
    ...(creds.accountId ? { [CODEX_HEADERS.ACCOUNT_ID]: creds.accountId } : {}),
  };
  try {
    const res = await transport.fetch(url, { method: 'GET', headers });
    const body = await res.json().catch(() => null);
    const models = Array.isArray(body?.models) ? body.models : Array.isArray(body?.data) ? body.data : [];
    const slugs = models.map((m) => m.slug ?? m.id).filter(Boolean);
    console.log(`[models ${v}] HTTP ${res.status} count=${slugs.length}`);
    console.log(`    ${slugs.join(', ') || JSON.stringify(body).slice(0, 200)}`);
  } catch (error) {
    console.log(`[models ${v}] FAILED: ${error?.cause?.message ?? error?.message ?? error}`);
  }
}

console.log(`[stream] model=${model} version=${streamVersion} …`);
const adapter = new CodexAdapter({ options: () => config, credentials });
let text = '';
let finish;
let usage;
try {
  for await (const chunk of adapter.stream({
    provider: 'codex',
    model,
    system: '你是一个测试助手,回答尽量简短。',
    reasoningEffort: 'medium',
    messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字:你好' }] }],
  })) {
    if (chunk.type === 'text-delta') text += chunk.text;
    else if (chunk.type === 'finish') finish = chunk.reason;
    else if (chunk.type === 'usage') usage = chunk.usage;
  }
} catch (error) {
  console.log(`[stream] ERROR code=${error?.code} message=${error?.message}`);
  process.exit(1);
}
console.log(`[stream] text=${JSON.stringify(text)}`);
console.log(`[stream] finish=${finish?.kind}${finish?.kind === 'error' ? ` (${finish.failure?.message})` : ''}`);
console.log(`[stream] usage=${usage ? JSON.stringify(usage) : 'n/a'}`);
console.log(finish?.kind === 'stop' && text.trim().length > 0 ? 'WIRE OK' : 'WIRE FAILED');
