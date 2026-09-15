/**
 * 模型目录:实时拉取 ChatGPT 后端的 /codex/models,失败时依次回退到
 * `~/.codex/models_cache.json`(codex CLI/桌面端缓存)与内置静态列表。
 */

import { readFile } from 'node:fs/promises';

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';

import {
  CODEX_HEADERS,
  CODEX_HEADER_VALUES,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  GPT_5_6_CONTEXT_WINDOW,
} from './constants.js';
import {
  CODEX_FAST_SUFFIX,
  fastServiceTier,
  normalizeServiceTiers,
  parsePickerModelId,
  supportsFast,
} from './service-tier.js';

const DEFAULT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const DEFAULT_INPUT = ['text'];

function normalizeDescription(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeLegacySpeedTiers(value) {
  return Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === 'string' && item.length > 0))] : [];
}

function catalogFields(entry) {
  return {
    description: normalizeDescription(entry?.description),
    serviceTiers: normalizeServiceTiers(entry),
    additionalSpeedTiers: normalizeLegacySpeedTiers(entry?.additionalSpeedTiers ?? entry?.additional_speed_tiers),
  };
}

function normalizeInput(value) {
  if (!Array.isArray(value)) return [...DEFAULT_INPUT];
  const input = [...new Set(value)].filter((item) => item === 'text' || item === 'image');
  return input.length > 0 ? input : [...DEFAULT_INPUT];
}

/** 内置兜底模型目录(与用户 models_cache.json 及 codex 发布节奏对齐)。 */
export const STATIC_MODELS = [
  {
    id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', input: ['text', 'image'],
    serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Priority processing' }],
  },
  {
    id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', input: ['text', 'image'],
    serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Priority processing' }],
  },
  {
    id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', input: ['text', 'image'],
    serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Priority processing' }],
  },
  { id: 'gpt-5.5', name: 'GPT-5.5' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4-Mini' },
  { id: 'gpt-5.2-codex-mini', name: 'GPT-5.2-Codex-Mini' },
  { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1-Codex-Mini' },
  { id: 'o4-mini', name: 'O4-Mini' },
];

/** GPT-5.6 luna/sol/terra 的硬上下文;其余模型走通用窗口。 */
export function contextWindowFor(modelId) {
  return /^gpt-5\.6/.test(modelId ?? '') ? GPT_5_6_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW;
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
        input: entry?.input ?? entry?.input_modalities,
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
        ...catalogFields(entry),
      });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** 从 ChatGPT 后端拉取实时模型目录(GET {base}/codex/models)。任何失败返回 null。 */
export async function discoverModelsLive(creds, clientVersion, signal, transport) {
  try {
    const url = new URL(`${creds.baseURL}/codex/models`);
    url.searchParams.set('client_version', clientVersion);
    const headers = {
      authorization: `Bearer ${creds.mode === 'apikey' ? creds.apiKey : creds.accessToken}`,
      accept: 'application/json',
    };
    if (creds.mode === 'chatgpt') {
      headers[CODEX_HEADERS.BETA] = CODEX_HEADER_VALUES.BETA_RESPONSES;
      headers[CODEX_HEADERS.ORIGINATOR] = CODEX_HEADER_VALUES.ORIGINATOR;
      headers[CODEX_HEADERS.VERSION] = clientVersion;
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
        input: entry?.input ?? entry?.input_modalities,
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
        ...catalogFields(entry),
      });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** 给目录条目补全上下文/输出上限/推理等级等缺省值。 */
export function completeEntry(entry) {
  const parsed = parsePickerModelId(entry.id);
  const contextWindow = entry.contextWindow ?? contextWindowFor(parsed.wireId);
  const maxTokens = Math.min(entry.maxTokens ?? DEFAULT_MAX_TOKENS, contextWindow);
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    input: normalizeInput(entry.input),
    contextWindow,
    maxTokens,
    defaultEffort: entry.defaultEffort ?? 'medium',
    efforts: Array.isArray(entry.efforts) && entry.efforts.length > 0 ? entry.efforts : DEFAULT_EFFORTS,
    serviceTiers: normalizeServiceTiers(entry),
    additionalSpeedTiers: normalizeLegacySpeedTiers(entry.additionalSpeedTiers ?? entry.additional_speed_tiers),
    ...parsed.fast ? { sourceFast: true } : {},
  };
}

function mergeEntry(base, incoming) {
  return completeEntry({
    ...base,
    ...incoming,
    name: base.name ?? incoming.name,
    description: base.description ?? incoming.description,
    input: [...new Set([...(base.input ?? []), ...(incoming.input ?? [])])],
    contextWindow: base.contextWindow ?? incoming.contextWindow,
    maxTokens: base.maxTokens ?? incoming.maxTokens,
    defaultEffort: base.defaultEffort ?? incoming.defaultEffort,
    efforts: base.efforts ?? incoming.efforts,
    serviceTiers: [...(base.serviceTiers ?? []), ...(incoming.serviceTiers ?? [])],
    additionalSpeedTiers: [...(base.additionalSpeedTiers ?? []), ...(incoming.additionalSpeedTiers ?? [])],
  });
}

function fastEntry(base, sourceFast = undefined) {
  const tier = fastServiceTier(base);
  return completeEntry({
    ...base,
    id: `${base.id}${CODEX_FAST_SUFFIX}`,
    name: sourceFast?.name && /\bfast\b/i.test(sourceFast.name) ? sourceFast.name : `${base.name} Fast`,
    description: sourceFast?.description ?? tier?.description ?? base.description,
    sourceFast: true,
  });
}

/** Normalize base ids, merge duplicates, then derive a single Fast row. */
export function expandCatalogEntries(entries) {
  const byWireId = new Map();
  const fastSources = new Map();
  for (const raw of entries ?? []) {
    if (!raw || typeof raw.id !== 'string' || raw.id.length === 0) continue;
    const parsed = parsePickerModelId(raw.id);
    const normalized = { ...raw, id: parsed.wireId };
    const current = byWireId.get(parsed.wireId);
    byWireId.set(parsed.wireId, current === undefined ? completeEntry(normalized) : mergeEntry(current, normalized));
    if (parsed.fast || supportsFast(raw)) {
      const existing = fastSources.get(parsed.wireId);
      fastSources.set(parsed.wireId, existing ?? {
        name: raw.name,
        description: raw.description ?? fastServiceTier(raw)?.description,
      });
    }
  }
  const out = [];
  for (const base of byWireId.values()) {
    out.push(base);
    if (supportsFast(base) || fastSources.has(base.id)) out.push(fastEntry(base, fastSources.get(base.id)));
  }
  return out;
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
      description: entry.description,
      input: entry.input,
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      serviceTiers: entry.serviceTiers ?? entry.service_tiers,
      additionalSpeedTiers: entry.additionalSpeedTiers ?? entry.additional_speed_tiers,
    }));
  } else {
    const liveSignal = signal ?? AbortSignal.timeout(10_000);
    entries = await discoverModelsLive(creds, config.clientVersion, liveSignal, transport);
    if (entries === null) {
      entries = await readModelsCacheFile(config.modelsCacheFile);
    }
    if (entries === null) {
      entries = STATIC_MODELS;
    }
  }

  return expandCatalogEntries(entries);
}

/** 供 adapter 使用的推理等级展示元数据。 */
export function reasoningInfo(entry) {
  return {
    efforts: entry.efforts.map((effort) => ({ id: ReasoningEffortId(effort), name: effort })),
    defaultEffort: ReasoningEffortId(entry.defaultEffort),
  };
}
