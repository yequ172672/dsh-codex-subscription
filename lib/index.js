/**
 * dsh-llm-codex:在 DSH 中注册 `codex` LLM provider,复用 Codex CLI 本地
 * 登录凭证(~/.codex/auth.json),让 ChatGPT 订阅模型(gpt-6.1-sol 等)直接
 * 出现在 DSH 的模型选择器里。
 *
 * 组成方式(与 @deepseek-ai/dsh-llm-pi-ai / dsh-llm-deepseek 同构):
 *   - id: llm-codex
 *     name: dsh-llm-codex
 *
 * DSH ≥ 44(宿主 dsh-llm 0.2.x)的配置模型:
 *   - 本插件导出 `Config`,字段全部 `.volatile()`:Loader 把变更原地提交进
 *     运行中的引用(`.get()` 实时可见),不重启插件;设置页由 Config 表单
 *     自动生成(settingsNs = loader entry id)。
 *   - 可配置字段(设置 → 本插件配置,或 profile cordis.patch.yml 的 entry config):
 *     clientVersion / writeBack / streamIdleTimeoutMs / proxy / authFile /
 *     modelsCacheFile / staticModels。
 */

import z from '@deepseek-ai/schemastery';
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';

import { CodexAdapter } from './adapter.js';
import { CodexCredentials } from './auth.js';
import { DEFAULT_CODEX_CLIENT_VERSION } from './constants.js';
import { createTransport, resolveProxyUrl } from './transport.js';

export const name = 'llm-codex';
export const inject = ['llm'];

/** 本插件唯一的 provider 路由。 */
export const PROVIDER = 'codex';

/** 目录条目 ns 的兜底值;实际取 loader entry id(cordis.bundle.yml 里为 llm-codex)。 */
const DEFAULT_SETTINGS_NS = 'llm-codex';

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

export const Config = z.object({
  clientVersion: z.string().default(DEFAULT_CODEX_CLIENT_VERSION).volatile(),
  writeBack: z.boolean().default(true).volatile(),
  streamIdleTimeoutMs: z
    .number()
    .min(Number.MIN_VALUE)
    .max(MAX_TIMER_DELAY_MS)
    .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
    .volatile(),
  proxy: z.string().volatile(),
  authFile: z.string().volatile(),
  modelsCacheFile: z.string().volatile(),
  staticModels: z
    .array(
      z.object({
        id: z.string().required(),
        name: z.string(),
        contextWindow: z.number().min(1),
        maxTokens: z.number().min(1),
      }),
    )
    .volatile(),
});

/** 展开配置:volatile 字段读 `.get()`,普通字段原样(兼容编程式构造)。 */
function plainConfig(config) {
  const plain = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    plain[key] = typeof value?.get === 'function' ? value.get() : value;
  }
  return plain;
}

/** 把原始配置解析为安全默认值填充的连接事实。 */
function resolveOptions(raw) {
  const source = raw ?? {};
  const clientVersion =
    typeof source.clientVersion === 'string' && source.clientVersion.trim().length > 0
      ? source.clientVersion.trim()
      : DEFAULT_CODEX_CLIENT_VERSION;
  const streamIdleTimeoutMs =
    Number.isFinite(source.streamIdleTimeoutMs) && source.streamIdleTimeoutMs > 0
      ? source.streamIdleTimeoutMs
      : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  return {
    clientVersion,
    writeBack: source.writeBack !== false,
    streamIdleTimeoutMs,
    proxy: typeof source.proxy === 'string' && source.proxy.trim().length > 0 ? source.proxy.trim() : undefined,
    authFile: typeof source.authFile === 'string' && source.authFile.length > 0 ? source.authFile : undefined,
    modelsCacheFile:
      typeof source.modelsCacheFile === 'string' && source.modelsCacheFile.length > 0
        ? source.modelsCacheFile
        : undefined,
    staticModels:
      Array.isArray(source.staticModels) && source.staticModels.length > 0 ? source.staticModels : undefined,
  };
}

export function apply(ctx, config) {
  let lastGood;

  const options = () => {
    try {
      const next = resolveOptions(plainConfig(config));
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === undefined) throw error;
      ctx.logger?.error?.('llm-codex: 配置无效,保留最后一次有效配置');
      ctx.logger?.error?.(error);
      return lastGood;
    }
  };

  // 先求值一次:配置非法时在装载期立刻失败(loud fail)
  options();

  // 传输对象按代理地址缓存;代理配置变化时自动重建
  let transportCache = { key: undefined, promise: undefined };
  const getTransport = () => {
    const key = resolveProxyUrl(options()) ?? '';
    if (transportCache.promise === undefined || transportCache.key !== key) {
      transportCache = { key, promise: createTransport(options()) };
    }
    return transportCache.promise;
  };

  const credentials = new CodexCredentials(() => ({
    ...options(),
    fetch: (url, init) => getTransport().then((transport) => transport.fetch(url, init)),
  }));
  const adapter = new CodexAdapter({ options, credentials, transport: getTransport });

  // 0.2.0:设置文档的命名空间就是 loader entry id,表单由 Config 投影而来
  const settingsNs = ctx.fiber?.entry?.options?.id ?? DEFAULT_SETTINGS_NS;

  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: 'Codex (ChatGPT 订阅)',
      settingsNs,
      settingsPath: [],
    },
  ]);

  // 路由集合恒定(单 provider),注册一次即可;volatile 配置由每次请求重新
  // 求值的 options() 吸收,无需在 loader/volatile-update 上重注册。
  ctx.llm.registerAdapter([PROVIDER], adapter);
}

const plugin = { name, inject, apply, Config };
export default plugin;
