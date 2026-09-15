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
 *   - clientVersion: codex wire 版本(默认 0.144.1)
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

const Config = z.object({
  clientVersion: z.string().default(DEFAULT_CODEX_CLIENT_VERSION),
  writeBack: z.boolean().default(true),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  maxRequestImageBytes: z.number().min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
  requestImagePixelBudget: z.number().min(1).default(DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET),
  requestImageMaxBytes: z.number().min(1).default(DEFAULT_REQUEST_IMAGE_MAX_BYTES),
  proxy: z.string(),
  authFile: z.string(),
  modelsCacheFile: z.string(),
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
  ),
});

/** 把原始配置(composer 行或设置段)解析为安全默认值填充的连接事实。 */
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
  const maxRequestImageBytes =
    Number.isFinite(source.maxRequestImageBytes) && source.maxRequestImageBytes > 0
      ? source.maxRequestImageBytes
      : DEFAULT_MAX_REQUEST_IMAGE_BYTES;
  const requestImagePixelBudget =
    Number.isFinite(source.requestImagePixelBudget) && source.requestImagePixelBudget > 0
      ? source.requestImagePixelBudget
      : DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET;
  const requestImageMaxBytes =
    Number.isFinite(source.requestImageMaxBytes) && source.requestImageMaxBytes > 0
      ? source.requestImageMaxBytes
      : DEFAULT_REQUEST_IMAGE_MAX_BYTES;
  return {
    clientVersion,
    writeBack: source.writeBack !== false,
    streamIdleTimeoutMs,
    maxRequestImageBytes,
    requestImagePixelBudget,
    requestImageMaxBytes,
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
  let current = () => config;
  let lastRaw;
  let lastGood;

  const options = () => {
    const raw = current();
    if (raw === lastRaw && lastGood !== undefined) return lastGood;
    try {
      const next = resolveOptions(raw);
      lastRaw = raw;
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === undefined) throw error;
      ctx.logger?.error?.('llm-codex: 设置段无效,保留最后一次有效配置');
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
  const adapter = new CodexAdapter({
    options,
    credentials,
    transport: getTransport,
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
    sctx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source) => {
        current = source;
      },
      onChange: () => {
        // 设置段变化后重注册路由,保持注册事实与配置一致
        registration.replace([PROVIDER]);
      },
    });
  });
}

const plugin = { name, inject, apply };
export default plugin;
