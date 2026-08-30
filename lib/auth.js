/**
 * Codex CLI 本地凭证的读取与刷新。
 *
 * 凭证来源是 codex CLI 的 `~/.codex/auth.json`(CODEX_HOME 可覆盖),与 CLI
 * 完全同源,因此「用户已登录的 codex 凭证」天然被复用:CLI 登录/退出/换号,
 * 本插件下一次请求自动跟随。文件里两种形态:
 *
 * - `OPENAI_API_KEY`(auth_mode: apikey)→ 官方 API:`api.openai.com/v1/responses`
 * - `tokens`(auth_mode: chatgpt)→ ChatGPT 订阅:`chatgpt.com/backend-api/codex/responses`,
 *   Bearer `tokens.access_token` + `chatgpt-account-id: tokens.account_id`
 *
 * 订阅 access_token 过期(HTTP 401)时,用 `tokens.refresh_token` 走
 * `auth.openai.com/oauth/token` 刷新一次;刷新成功后默认把新令牌原子写回
 * auth.json(codex CLI 自身也会这么做,保证两边凭证始终一致),`writeBack:
 * false` 可关闭。
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LlmError } from '@deepseek-ai/dsh-llm';

import {
  CHATGPT_BASE_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_URL,
  OPENAI_API_BASE_URL,
} from './constants.js';
import { safeRawSummary } from './provider-error.js';

const REFRESH_TIMEOUT_MS = 15_000;

/** 解析 Codex 配置目录:显式配置 > CODEX_HOME > ~/.codex。 */
export function codexHomeDir(override) {
  if (typeof override === 'string' && override.trim().length > 0) return override;
  const env = process.env.CODEX_HOME;
  if (typeof env === 'string' && env.trim().length > 0) return env;
  return path.join(os.homedir(), '.codex');
}

export function defaultAuthFile(override) {
  if (typeof override === 'string' && override.trim().length > 0) return override;
  return path.join(codexHomeDir(), 'auth.json');
}

export function defaultModelsCacheFile(override) {
  if (typeof override === 'string' && override.trim().length > 0) return override;
  return path.join(codexHomeDir(), 'models_cache.json');
}

/** 读取 codex CLI 的 auth.json;缺失/损坏时抛 MISSING_CREDENTIAL。 */
export async function readAuthFile(authFile) {
  let raw;
  try {
    raw = await readFile(authFile, 'utf8');
  } catch (error) {
    throw new LlmError(
      `无法读取 Codex 凭证文件 ${authFile}:请先运行 "codex login" 完成登录(或改用 OPENAI_API_KEY)。`,
      'MISSING_CREDENTIAL',
      { cause: error },
    );
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new LlmError(`Codex 凭证文件 ${authFile} 不是合法 JSON。`, 'MISSING_CREDENTIAL', { cause: error });
  }
}

/**
 * 从 auth.json 解析出当前生效的凭证形态。
 * 优先级与 codex CLI 一致:显式 auth_mode 优先;否则有 OPENAI_API_KEY 走
 * API key,否则有 tokens 走 ChatGPT 订阅。
 */
export function resolveCredentials(auth) {
  const mode = typeof auth?.auth_mode === 'string' ? auth.auth_mode : undefined;
  const apiKey =
    typeof auth?.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim().length > 0
      ? auth.OPENAI_API_KEY.trim()
      : undefined;
  const tokens = auth?.tokens;
  const accessToken =
    tokens && typeof tokens.access_token === 'string' && tokens.access_token.length > 0
      ? tokens.access_token
      : undefined;

  if (mode === 'apikey' || (mode === undefined && apiKey && !accessToken)) {
    if (!apiKey) throw new LlmError('Codex auth.json 缺少 OPENAI_API_KEY。', 'MISSING_CREDENTIAL');
    return { mode: 'apikey', apiKey, baseURL: OPENAI_API_BASE_URL };
  }

  if (mode === 'chatgpt' || accessToken) {
    if (!accessToken) throw new LlmError('Codex auth.json 缺少 tokens.access_token。', 'MISSING_CREDENTIAL');
    return {
      mode: 'chatgpt',
      accessToken,
      refreshToken:
        tokens && typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0
          ? tokens.refresh_token
          : undefined,
      accountId:
        tokens && typeof tokens.account_id === 'string' && tokens.account_id.length > 0
          ? tokens.account_id
          : undefined,
      baseURL: CHATGPT_BASE_URL,
    };
  }

  throw new LlmError(
    'Codex auth.json 中既没有 OPENAI_API_KEY 也没有 tokens;请先运行 "codex login"。',
    'MISSING_CREDENTIAL',
  );
}

/** 通过 auth.openai.com 的 refresh_token grant 刷新 ChatGPT 订阅令牌。 */
export async function refreshChatgptTokens(refreshToken, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CODEX_OAUTH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new LlmError('Codex 令牌刷新请求失败', 'TRANSPORT', { cause: error });
  }
  const bodyText = await response.text();
  if (!response.ok) {
    throw new LlmError(
      `Codex 令牌刷新失败(HTTP ${response.status}):${safeRawSummary(bodyText, 400)}`,
      'AUTH',
      { status: response.status },
    );
  }
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new LlmError('Codex 令牌刷新返回了无法解析的响应。', 'AUTH');
  }
  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new LlmError('Codex 令牌刷新响应缺少 access_token。', 'AUTH');
  }
  return {
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === 'string' && data.refresh_token.length > 0
        ? data.refresh_token
        : refreshToken,
    expiresIn: typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : undefined,
  };
}

/** 原子写回 auth.json(临时文件 + rename),保留未知字段,只更新 tokens/last_refresh。 */
export async function writeBackTokens(authFile, auth, refreshed) {
  const next = { ...auth };
  const tokens = { ...(auth.tokens ?? {}) };
  tokens.access_token = refreshed.accessToken;
  tokens.refresh_token = refreshed.refreshToken;
  if (typeof auth.tokens?.id_token === 'string') tokens.id_token = auth.tokens.id_token;
  if (typeof auth.tokens?.account_id === 'string') tokens.account_id = auth.tokens.account_id;
  next.tokens = tokens;
  next.last_refresh = new Date().toISOString();
  if (typeof next.auth_mode === 'string' && next.auth_mode !== 'chatgpt') next.auth_mode = 'chatgpt';
  const tmp = `${authFile}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(tmp, authFile);
}

/**
 * Codex 凭证管理器:每次请求重读 auth.json(与 codex CLI 保持同步);
 * 401 时用 refresh_token 刷新一次并(默认)写回 auth.json。
 * 并发刷新通过共享的 in-flight promise 去重。
 */
export class CodexCredentials {
  /**
   * @param config - 配置对象,或返回配置对象的 thunk(设置热更新时配置随每次
   *   请求重新求值)。字段:`authFile`、`writeBack`(默认 true)、`fetch`。
   */
  constructor(config) {
    this._options = typeof config === 'function' ? config : () => config ?? {};
    this._refreshing = undefined;
  }

  #options() {
    return this._options();
  }

  get fetchImpl() {
    const opts = this.#options();
    return typeof opts.fetch === 'function' ? opts.fetch : fetch;
  }

  get authFile() {
    return defaultAuthFile(this.#options().authFile);
  }

  get writeBack() {
    return this.#options().writeBack !== false;
  }

  /** 解析当前凭证(auth.json 缺失时抛 MISSING_CREDENTIAL)。 */
  async current() {
    const auth = await readAuthFile(defaultAuthFile(this.#options().authFile));
    return resolveCredentials(auth);
  }

  /** 刷新 ChatGPT 订阅令牌;失败抛 AUTH。并发调用共享同一次刷新。 */
  refresh() {
    if (this._refreshing !== undefined) return this._refreshing;
    this._refreshing = this.#doRefresh().finally(() => {
      this._refreshing = undefined;
    });
    return this._refreshing;
  }

  async #doRefresh() {
    const config = this.#options();
    const authFile = defaultAuthFile(config.authFile);
    const auth = await readAuthFile(authFile);
    const creds = resolveCredentials(auth);
    if (creds.mode !== 'chatgpt' || !creds.refreshToken) {
      throw new LlmError('当前 Codex 凭证不是 ChatGPT 订阅模式,无法刷新。', 'AUTH');
    }
    const refreshed = await refreshChatgptTokens(creds.refreshToken, this.fetchImpl);
    if (config.writeBack !== false) {
      try {
        await writeBackTokens(authFile, auth, refreshed);
      } catch (error) {
        // 写回失败不致命:本次请求继续用内存中的新令牌,下次重启会重新刷新
        console.error(`[dsh-llm-codex] 写回 ${authFile} 失败:`, error?.message ?? error);
      }
    }
    return { ...creds, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken };
  }
}
