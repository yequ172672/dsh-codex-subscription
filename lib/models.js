/**
 * 模型目录:实时拉取 ChatGPT 后端的 /codex/models,失败时依次回退到
 * `~/.codex/models_cache.json`(codex CLI/桌面端缓存)与内置静态列表。
 */

import { readFile } from 'node:fs/promises';

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';

import { defaultModelsCacheFile } from './auth.js';
import {
  CODEX_HEADERS,
  CODEX_HEADER_VALUES,
  DEFAULT_CODEX_CLIENT_VERSION,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  GPT_6_1_CONTEXT_WINDOW,
} from './constants.js';

const DEFAULT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
/** luna/reserve/复核系 SKU 无 ultra;gpt-5.5 只到 xhigh(2026-10 目录实测)。 */
const LUNA_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const GPT_5_5_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

/**
 * 内置兜底模型目录(与 2026-10 Codex 实时目录对齐;实时发现与
 * models_cache.json 都不可用时才会用到)。
 */
export const STATIC_MODELS = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', contextWindow: GPT_6_1_CONTEXT_WINDOW, defaultEffort: 'low' },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-6-sol', name: 'GPT-6-Sol', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-6-luna', name: 'GPT-6-Luna', contextWindow: DEFAULT_CONTEXT_WINDOW, efforts: LUNA_EFFORTS },
  { id: 'gpt-reserve', name: 'GPT-Reserve', contextWindow: DEFAULT_CONTEXT_WINDOW, efforts: LUNA_EFFORTS },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: DEFAULT_CONTEXT_WINDOW, defaultEffort: 'low' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', contextWindow: DEFAULT_CONTEXT_WINDOW, efforts: LUNA_EFFORTS },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: DEFAULT_CONTEXT_WINDOW, efforts: GPT_5_5_EFFORTS },
  { id: 'codex-auto-review', name: 'Codex Auto Review', contextWindow: DEFAULT_CONTEXT_WINDOW, efforts: LUNA_EFFORTS },
];

/** GPT-6.1 系的硬上下文;其余模型走通用窗口。 */
export function contextWindowFor(modelId) {
  return /^gpt-6\.1/.test(modelId ?? '') ? GPT_6_1_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW;
}

/** 读取 ~/.codex/models_cache.json(Codex 缓存的最新模型目录)。 */
export async function readModelsCacheFile(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(raw);
    const entries = Array.isArray(data.models) ? data.models : Array.isArray(data.data) ? data.data : [];
    const out = [];
    for (const entry of entries) {
      const id = typeof entry?.slug === 'string' ? entry.slug : entry?.id;
      if (typeof id !== 'string' || id.length === 0) continue;
      const visibility = typeof entry?.visibility === 'string' ? entry.visibility.toLowerCase() : undefined;
      if (visibility === 'hide' || visibility === 'hidden') continue;
      out.push({
        id,
        name: typeof entry?.display_name === 'string' && entry.display_name.length > 0 ? entry.display_name : id,
        contextWindow:
          typeof entry?.context_window === 'number' && entry.context_window > 0 ? entry.context_window : undefined,
        defaultEffort:
          typeof entry?.default_reasoning_level === 'string' && entry.default_reasoning_level.length > 0
            ? entry.default_reasoning_level
            : undefined,
        efforts: Array.isArray(entry?.supported_reasoning_levels)
          ? entry.supported_reasoning_levels
              .map((item) => (typeof item === 'string' ? item : item?.effort))
              .filter((item) => typeof item === 'string' && item.length > 0)
          : undefined,
      });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** 从 ChatGPT 后端拉取实时模型目录(GET {base}/codex/models)。任何失败返回 null。 */
export async function discoverModelsLive(creds, clientVersion, signal, transport) {
  // 未配置时也要落到默认 wire 版本:把 undefined 写进 query/header 会让
  // 服务端拿到字面量 "undefined" 而拒绝目录。
  const version =
    typeof clientVersion === 'string' && clientVersion.trim().length > 0
      ? clientVersion.trim()
      : DEFAULT_CODEX_CLIENT_VERSION;
  try {
    const url = new URL(`${creds.baseURL}/codex/models`);
    url.searchParams.set('client_version', version);
    const headers = {
      authorization: `Bearer ${creds.mode === 'apikey' ? creds.apiKey : creds.accessToken}`,
      accept: 'application/json',
    };
    if (creds.mode === 'chatgpt') {
      headers[CODEX_HEADERS.BETA] = CODEX_HEADER_VALUES.BETA_RESPONSES;
      headers[CODEX_HEADERS.ORIGINATOR] = CODEX_HEADER_VALUES.ORIGINATOR;
      headers[CODEX_HEADERS.VERSION] = version;
      if (creds.accountId) headers[CODEX_HEADERS.ACCOUNT_ID] = creds.accountId;
    }
    const response = await transport.fetch(url, { method: 'GET', headers, signal });
    if (!response.ok) return null;
    const data = await response.json();
    const entries = Array.isArray(data.models) ? data.models : Array.isArray(data.data) ? data.data : [];
    const out = [];
    for (const entry of entries) {
      const id = typeof entry?.slug === 'string' ? entry.slug : entry?.id;
      if (typeof id !== 'string' || id.length === 0) continue;
      const visibility = typeof entry?.visibility === 'string' ? entry.visibility.toLowerCase() : undefined;
      if (visibility === 'hide' || visibility === 'hidden') continue;
      out.push({
        id,
        name: typeof entry?.display_name === 'string' && entry.display_name.length > 0 ? entry.display_name : id,
        contextWindow:
          typeof entry?.context_window === 'number' && entry.context_window > 0 ? entry.context_window : undefined,
        defaultEffort:
          typeof entry?.default_reasoning_level === 'string' && entry.default_reasoning_level.length > 0
            ? entry.default_reasoning_level
            : undefined,
        efforts: Array.isArray(entry?.supported_reasoning_levels)
          ? entry.supported_reasoning_levels
              .map((item) => (typeof item === 'string' ? item : item?.effort))
              .filter((item) => typeof item === 'string' && item.length > 0)
          : undefined,
      });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** 给目录条目补全上下文/输出上限/推理等级等缺省值。 */
export function completeEntry(entry) {
  const contextWindow = entry.contextWindow ?? contextWindowFor(entry.id);
  const maxTokens = Math.min(entry.maxTokens ?? DEFAULT_MAX_TOKENS, contextWindow);
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    contextWindow,
    maxTokens,
    defaultEffort: entry.defaultEffort ?? 'medium',
    efforts: Array.isArray(entry.efforts) && entry.efforts.length > 0 ? entry.efforts : DEFAULT_EFFORTS,
  };
}

/**
 * 组装最终目录,优先级:显式 staticModels 配置 > 实时发现 > models_cache.json > 内置列表。
 * @returns 去重后的完整条目列表。
 */
export async function buildCatalog(creds, config, signal, transport) {
  let entries = null;

  if (Array.isArray(config.staticModels) && config.staticModels.length > 0) {
    entries = config.staticModels.map((entry) => ({
      id: entry.id,
      name: entry.name ?? entry.id,
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
    }));
  } else {
    const liveSignal = signal ?? AbortSignal.timeout(10_000);
    entries = await discoverModelsLive(creds, config.clientVersion, liveSignal, transport);
    if (entries === null) {
      // 缺省路径必须由 defaultModelsCacheFile 解析:未显式配置时旧实现
      // 传了 undefined 给 readFile,导致缓存兜底永远静默失败。
      entries = await readModelsCacheFile(defaultModelsCacheFile(config.modelsCacheFile));
    }
    if (entries === null) {
      entries = STATIC_MODELS;
    }
  }

  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(completeEntry(entry));
  }
  return out;
}

/** 供 adapter 使用的推理等级展示元数据。 */
export function reasoningInfo(entry) {
  return {
    efforts: entry.efforts.map((effort) => ({ id: ReasoningEffortId(effort), name: effort })),
    defaultEffort: ReasoningEffortId(entry.defaultEffort),
  };
}
