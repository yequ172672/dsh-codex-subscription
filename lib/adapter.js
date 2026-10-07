/**
 * CodexAdapter:复用 Codex CLI 本地凭证的 LLM 适配器。
 *
 * 传输层与 dsh-llm-deepseek 同构:fetch + SSE → harness StreamChunk;
 * 凭证按请求解析(auth.json 热跟随),401 时刷新订阅令牌并重试一次。
 */

import {
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  ReasoningEffortId,
  attributionHeaders,
} from '@deepseek-ai/dsh-llm';
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout';

import { CODEX_HEADERS, CODEX_HEADER_VALUES, DEFAULT_CODEX_CLIENT_VERSION, DEFAULT_MAX_TOKENS } from './constants.js';
import { buildCatalog, reasoningInfo } from './models.js';
import { serializeRequest } from './serialize.js';
import { parseSse } from './sse.js';
import { createTransport } from './transport.js';
import { translate } from './translate.js';

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT';
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
/** 模型目录内存缓存时长:0.2.x 宿主每次模型调用都会经 resolveModel 问一次目录。 */
const CATALOG_TTL_MS = 60_000;

function providerRetryAfterMs(value) {
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1000;
    return Number.isFinite(delay) && delay > 0 ? delay : undefined;
  }
  const delay = Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

function requestId(headers) {
  const value = headers.get('x-request-id') ?? headers.get('x-req-id');
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value);
}

/** 把 HTTP 状态映射为稳定错误码(与 dsh-llm-deepseek 同 taxonomy)。 */
function httpErrorCode(status, error) {
  if (status === 401 || status === 403) return 'AUTH';
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ');
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400) return 'INVALID_REQUEST';
  if (status >= 500) return 'SERVER';
  return `HTTP_${status}`;
}

export class CodexAdapter extends LlmAdapter {
  /**
   * @param options - `() => resolved config`,每次请求重新求值以支持设置热更新。
   * @param credentials - CodexCredentials 实例。
   * @param transport - `() => Promise<{ fetch, toWebStream }>` 传输对象工厂(代理支持);
   *   缺省按 options 自动构造(同样感知 proxy 配置)。
   * @param fetchImpl - 可注入的 fetch(测试用),覆盖 transport。
   */
  constructor({ options, credentials, transport, fetchImpl }) {
    super();
    this.options = options;
    this.credentials = credentials;
    this.transport =
      typeof transport === 'function' ? transport : async () => createTransport(this.options());
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : undefined;
    this.catalogCache = undefined;
  }

  providerInfo(provider) {
    return { id: provider, name: 'Codex (ChatGPT 订阅)' };
  }

  providerRetryPolicy() {
    return undefined; // 使用 harness 的默认重试策略
  }

  /**
   * 组装模型目录,带 60s 内存缓存(按凭证形态/账号/版本/显式目录做键)。
   * 0.2.x 宿主在 prepareCall → resolveModel 路径上每次调用都会问目录,
   * 无缓存就意味着每轮对话先打一轮 /codex/models。
   * @returns `{ config, creds, catalog }`,creds 仍按请求即时读取(热跟随)。
   */
  async resolveCatalog(signal) {
    const config = this.options();
    const creds = await this.credentials.current();
    const transport = await this.transport();
    const key = JSON.stringify([
      creds.mode,
      creds.baseURL,
      creds.accountId ?? '',
      config.clientVersion,
      config.staticModels ?? null,
    ]);
    const now = Date.now();
    const hit = this.catalogCache;
    let catalog;
    if (hit !== undefined && hit.key === key && hit.expiresAt > now) {
      catalog = hit.value;
    } else {
      catalog = await buildCatalog(creds, config, signal, transport);
      this.catalogCache = { key, expiresAt: now + CATALOG_TTL_MS, value: catalog };
    }
    return { config, creds, catalog };
  }

  async listModels(provider) {
    const { catalog } = await this.resolveCatalog();
    return catalog.map((entry) => ({
      provider,
      id: entry.id,
      name: entry.name,
      inputModalities: ['text'],
    }));
  }

  async resolveModel(provider, model, signal) {
    const { config, creds, catalog } = await this.resolveCatalog(signal);
    const entry = catalog.find((item) => item.id === model);
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      inputModalities: ['text'],
      context: { contextWindow: entry?.contextWindow ?? 272_000 },
      // ChatGPT 订阅后端不支持 max_output_tokens(HTTP 400 "Unsupported parameter"),
      // 因此订阅模式不物化输出上限(用后端默认);仅官方 API key 模式物化。
      ...(creds.mode === 'apikey'
        ? { defaultMaxTokens: entry?.maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS }
        : {}),
      reasoning: reasoningInfo(entry ?? {
        id: model,
        name: model,
        contextWindow: 272_000,
        maxTokens: DEFAULT_MAX_TOKENS,
        defaultEffort: 'medium',
        efforts: DEFAULT_REASONING_EFFORTS,
      }),
    };
  }

  async *stream(options) {
    const config = this.options();
    const consumer = new AbortController();
    let watchdog;
    try {
      watchdog = idleWatchdog(
        options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]),
        config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        STREAM_IDLE_TIMEOUT_CODE,
      );
    } catch (error) {
      consumer.abort();
      throw error;
    }
    const iterator = this.request(options, watchdog.signal, () => watchdog.pulse())[Symbol.asyncIterator]();
    let exhausted = false;
    try {
      while (true) {
        const result = await watchdog.next(iterator);
        if (result.done) {
          exhausted = true;
          return;
        }
        yield result.value;
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `Codex stream idle timeout after ${config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS}ms`,
          'TIMEOUT',
          { cause: error },
        );
      }
      if (options.signal?.aborted) {
        throw new LlmError('Codex request aborted by caller', 'ABORTED', { cause: error });
      }
      if (error instanceof LlmError) throw error;
      throw new LlmError('Codex API stream failed', 'TRANSPORT', { cause: error });
    } finally {
      consumer.abort('Codex stream consumer stopped');
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return();
        } catch {
          // 传输层清理失败可忽略
        }
      }
      try {
        watchdog[Symbol.dispose]?.();
      } catch {
        // 计时器清理失败可忽略
      }
    }
  }

  async *request(options, signal, onComment) {
    const config = this.options();
    const body = serializeRequest(options);
    let retried = false;

    while (true) {
      const creds = await this.credentials.current();
      // ChatGPT 订阅后端是 Responses 协议的受限实现,以下标准字段会被拒绝
      // (HTTP 400 "Unsupported parameter: …"):max_output_tokens / temperature / stop。
      // 订阅模式一律剥离,改用后端默认;官方 API key 模式不受影响。
      if (creds.mode === 'chatgpt') {
        delete body.max_output_tokens;
        delete body.temperature;
        delete body.stop;
      }
      const payload = JSON.stringify(body);
      const headers = {
        authorization: `Bearer ${creds.mode === 'apikey' ? creds.apiKey : creds.accessToken}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...attributionHeaders(),
      };

      let url;
      if (creds.mode === 'apikey') {
        url = `${creds.baseURL}/responses`;
      } else {
        headers[CODEX_HEADERS.BETA] = CODEX_HEADER_VALUES.BETA_RESPONSES;
        headers[CODEX_HEADERS.ORIGINATOR] = CODEX_HEADER_VALUES.ORIGINATOR;
        headers[CODEX_HEADERS.VERSION] = config.clientVersion ?? DEFAULT_CODEX_CLIENT_VERSION;
        if (creds.accountId) headers[CODEX_HEADERS.ACCOUNT_ID] = creds.accountId;
        if (options.sessionId !== undefined) {
          const sid = String(options.sessionId);
          headers[CODEX_HEADERS.CONVERSATION_ID] = sid;
          headers[CODEX_HEADERS.SESSION_ID] = sid;
          headers[CODEX_HEADERS.REQUEST_ID] = sid;
        }
        url = `${creds.baseURL}/codex/responses`;
      }

      let response;
      try {
        const transport = await this.transport();
        const doFetch = this.fetchImpl ?? transport.fetch;
        response = await doFetch(url, { method: 'POST', headers, body: payload, signal });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new LlmError(`Codex API 请求 ${url} 失败`, 'TRANSPORT', { cause: error });
      }

      if (!response.ok) {
        let message = `Codex API error (HTTP ${response.status})`;
        let providerError;
        try {
          const json = await response.json();
          providerError = json?.error ?? json;
          if (typeof providerError?.message === 'string' && providerError.message.length > 0) {
            message = providerError.message;
          } else if (typeof providerError?.detail === 'string' && providerError.detail.length > 0) {
            message = providerError.detail;
          }
        } catch {
          // 保留默认消息
        }
        const delay = providerRetryAfterMs(response.headers.get('retry-after'));
        const id = requestId(response.headers);

        if (response.status === 401 && creds.mode === 'chatgpt' && !retried) {
          retried = true;
          await this.credentials.refresh(); // 刷新失败会抛 AUTH
          continue;
        }

        throw new LlmError(message, httpErrorCode(response.status, providerError), {
          status: response.status,
          ...(delay === undefined ? {} : { providerRetryAfterMs: delay }),
          ...(id === undefined ? {} : { requestId: id }),
        });
      }

      if (!response.body) throw new LlmError('Codex API 返回了空响应体', 'EMPTY_RESPONSE');
      yield* translate(parseSse(response.body, onComment));
      return;
    }
  }
}
