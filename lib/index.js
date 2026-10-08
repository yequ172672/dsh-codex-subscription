/**
 * dsh-llm-codex:在 DSH 中注册 `codex` LLM provider,复用 Codex CLI 本地
 * 登录凭证(~/.codex/auth.json),让 ChatGPT 订阅模型(gpt-5.6-sol 等)直接
 * 出现在 DSH 的模型选择器里。
 *
 * 组成方式(与 @deepseek-ai/dsh-llm-deepseek 同构):
 *   - id: llm-codex
 *     name: dsh-llm-codex
 *
 * 可选配置(composer 行 config 或 settings.yaml 的 `llm-codex:` 段,热更新):
 *   - clientVersion: codex wire 版本(默认 0.161.0;需支持新模型时应与 Codex CLI 同步)
 *   - writeBack:     刷新订阅令牌后是否写回 auth.json(默认 true)
 *   - authFile:      覆盖 auth.json 路径
 *   - modelsCacheFile: 覆盖 models_cache.json 路径
 *   - staticModels:  显式模型目录(覆盖自动发现)
 */

import z from '@deepseek-ai/schemastery';
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';

import { CodexAdapter } from './adapter.js';
import { CodexCredentials } from './auth.js';
import {
  DEFAULT_CODEX_CLIENT_VERSION,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
} from './constants.js';
import { createTransport, resolveProxyUrl } from './transport.js';

export const name = 'llm-codex';
export const inject = ['llm'];

/** 本插件唯一的 provider 路由。 */
export const PROVIDER = 'codex';

const NS = 'llm-codex';

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

export const Config = z.object({
  clientVersion: z.string().default(DEFAULT_CODEX_CLIENT_VERSION).volatile(),
  writeBack: z.boolean().default(true).volatile(),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS).volatile(),
  maxRequestImageBytes: z.number().min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES).volatile(),
  requestImagePixelBudget: z.number().min(1).default(DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET).volatile(),
  requestImageMaxBytes: z.number().min(1).default(DEFAULT_REQUEST_IMAGE_MAX_BYTES).volatile(),
  proxy: z.string().volatile(),
  authFile: z.string().volatile(),
  modelsCacheFile: z.string().volatile(),
  staticModels: z.array(
    z.object({
      id: z.string().required(),
      name: z.string(),
      description: z.string(),
      input: z.array(z.union(['text', 'image'])).default(['text']),
      contextWindow: z.number().min(1),
      maxTokens: z.number().min(1),
      serviceTiers: z.array(z.object({ id: z.string().required(), name: z.string(), description: z.string() })),
      additionalSpeedTiers: z.array(z.string()),
    }),
  ).volatile(),
});

function readConfigValue(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
}

/** 把 DSH 0.2 Config(包含 volatile 包装值)解析为安全默认值填充的连接事实。 */
function resolveOptions(raw) {
  const source = raw ?? {};
  const value = (key) => readConfigValue(source[key]);
  const clientVersionValue = value('clientVersion');
  const streamIdleTimeoutMsValue = value('streamIdleTimeoutMs');
  const maxRequestImageBytesValue = value('maxRequestImageBytes');
  const requestImagePixelBudgetValue = value('requestImagePixelBudget');
  const requestImageMaxBytesValue = value('requestImageMaxBytes');
  const writeBackValue = value('writeBack');
  const proxyValue = value('proxy');
  const authFileValue = value('authFile');
  const modelsCacheFileValue = value('modelsCacheFile');
  const staticModelsValue = value('staticModels');
  const clientVersion =
    typeof clientVersionValue === 'string' && clientVersionValue.trim().length > 0
      ? clientVersionValue.trim()
      : DEFAULT_CODEX_CLIENT_VERSION;
  const streamIdleTimeoutMs =
    Number.isFinite(streamIdleTimeoutMsValue) && streamIdleTimeoutMsValue > 0
      ? streamIdleTimeoutMsValue
      : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const maxRequestImageBytes =
    Number.isFinite(maxRequestImageBytesValue) && maxRequestImageBytesValue > 0
      ? maxRequestImageBytesValue
      : DEFAULT_MAX_REQUEST_IMAGE_BYTES;
  const requestImagePixelBudget =
    Number.isFinite(requestImagePixelBudgetValue) && requestImagePixelBudgetValue > 0
      ? requestImagePixelBudgetValue
      : DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET;
  const requestImageMaxBytes =
    Number.isFinite(requestImageMaxBytesValue) && requestImageMaxBytesValue > 0
      ? requestImageMaxBytesValue
      : DEFAULT_REQUEST_IMAGE_MAX_BYTES;
  return {
    clientVersion,
    writeBack: writeBackValue !== false,
    streamIdleTimeoutMs,
    maxRequestImageBytes,
    requestImagePixelBudget,
    requestImageMaxBytes,
    proxy: typeof proxyValue === 'string' && proxyValue.trim().length > 0 ? proxyValue.trim() : undefined,
    authFile: typeof authFileValue === 'string' && authFileValue.length > 0 ? authFileValue : undefined,
    modelsCacheFile:
      typeof modelsCacheFileValue === 'string' && modelsCacheFileValue.length > 0
        ? modelsCacheFileValue
        : undefined,
    staticModels:
      Array.isArray(staticModelsValue) && staticModelsValue.length > 0 ? staticModelsValue : undefined,
  };
}

export function apply(ctx, config) {
  const options = () => resolveOptions(config);

  // 先求值一次:配置非法时在装载期立刻失败(loud fail)
  options();

  // 传输对象按代理地址缓存;代理配置变化时自动重建
  let transportCache = { key: undefined, promise: undefined };
  const getTransport = (configOverride) => {
    const config = configOverride ?? options();
    const key = resolveProxyUrl(config) ?? '';
    if (configOverride !== undefined) return createTransport(config);
    if (transportCache.promise === undefined || transportCache.key !== key) {
      transportCache = { key, promise: createTransport(config) };
    }
    return transportCache.promise;
  };

  const credentials = new CodexCredentials(() => ({
    ...options(),
    fetch: (url, init) => getTransport().then((transport) => transport.fetch(url, init)),
  }));
  const adapter = new CodexAdapter({
    options,
    credentials,
    transport: (config) => getTransport(config),
    resolveAttachments: () => ctx.get('attachments'),
  });

  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: 'Codex (ChatGPT 订阅)',
      settingsNs: NS,
      settingsPath: [],
    },
  ]);

  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);

  ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber), 'llm-codex settings presentation');
  });
}

const plugin = { name, inject, apply };
export default plugin;
