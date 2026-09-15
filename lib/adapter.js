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
  attributionHeaders,
} from '@deepseek-ai/dsh-llm';
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout';

import { CODEX_HEADERS, CODEX_HEADER_VALUES, DEFAULT_CODEX_CLIENT_VERSION, DEFAULT_MAX_TOKENS } from './constants.js';
import { buildCatalog, reasoningInfo } from './models.js';
import { requestDiagnostics, serializeRequest, stringifyRequestBody } from './serialize.js';
import { parseSse } from './sse.js';
import { createTransport } from './transport.js';
import { createProviderError, extractProviderError, headerValue } from './provider-error.js';
import { translate } from './translate.js';

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT';
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

function providerRetryAfterMs(value) {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const delay = Number(text) * 1000;
    return Number.isFinite(delay) && delay >= 0 ? delay : undefined;
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return undefined;
  const delay = parsed - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

function requestId(headers) {
  const value = headerValue(headers, ['x-request-id', 'x-req-id', 'x-client-request-id', 'request-id', 'trace-id', 'x-trace-id']);
  return value === undefined ? undefined : ProviderRequestId(value);
}

export class CodexAdapter extends LlmAdapter {
  /**
   * @param options - `() => resolved config`,每次请求重新求值以支持设置热更新。
   * @param credentials - CodexCredentials 实例。
   * @param transport - `() => Promise<{ fetch, toWebStream }>` 传输对象工厂(代理支持);
   *   缺省按 options 自动构造(同样感知 proxy 配置)。
   * @param fetchImpl - 可注入的 fetch(测试用),覆盖 transport。
   * @param resolveAttachments - 可选的 DSH 附件服务解析器。
   */
  constructor({ options, credentials, transport, fetchImpl, resolveAttachments }) {
    super();
    this.options = options;
    this.credentials = credentials;
    this.transport =
      typeof transport === 'function' ? transport : async () => createTransport(this.options());
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : undefined;
    this.resolveAttachments = typeof resolveAttachments === 'function' ? resolveAttachments : undefined;
  }

  providerInfo(provider) {
    return { id: provider, name: 'Codex (ChatGPT 订阅)' };
  }

  providerRetryPolicy() {
    return undefined; // 使用 harness 的默认重试策略
  }

  async listModels(provider) {
    const config = this.options();
    const creds = await this.credentials.current();
    const transport = await this.transport();
    const catalog = await buildCatalog(creds, config, undefined, transport);
    return catalog.map((entry) => ({
      provider,
      id: entry.id,
      name: entry.name,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      inputModalities: entry.input,
    }));
  }

  async resolveModel(provider, model, signal) {
    const config = this.options();
    const creds = await this.credentials.current();
    const transport = await this.transport();
    const catalog = await buildCatalog(creds, config, signal, transport);
    const entry = catalog.find((item) => item.id === model);
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      ...(entry?.description === undefined ? {} : { description: entry.description }),
      inputModalities: entry?.input ?? ['text'],
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
        const info = await extractProviderError(
          { message: `Codex stream idle timeout after ${config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS}ms`, code: 'STREAM_IDLE_TIMEOUT' },
          { provider: options.provider ?? 'codex', model: options.model },
        );
        throw createProviderError(info, 'Codex stream idle timeout', { cause: error });
      }
      if (options.signal?.aborted) {
        throw new LlmError('Codex request aborted by caller', 'ABORTED', { cause: error });
      }
      if (error instanceof LlmError) throw error;
      const info = await extractProviderError(error, {
        provider: options.provider ?? 'codex',
        model: options.model,
      });
      throw createProviderError(info, 'Codex API stream failed');
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
    const body = await serializeRequest(options, this.resolveAttachments?.(), config, signal);
    let retried = false;
    let diagnostics;

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
      const payload = stringifyRequestBody(body);
      diagnostics = requestDiagnostics(options, body, payload, config);
      this.lastDiagnostics = diagnostics;
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
        const info = await extractProviderError(error, {
          provider: options.provider ?? 'codex',
          model: options.model,
          diagnostics,
        });
        throw createProviderError(info, 'Codex transport error');
      }

      if (!response.ok) {
        const id = requestId(response.headers);
        const info = await extractProviderError(response, {
          provider: options.provider ?? 'codex',
          model: options.model,
          requestId: id,
          diagnostics,
        });
        let retryAfterValue;
        try {
          retryAfterValue = response.headers?.get?.('retry-after') ?? response.headers?.['retry-after'] ?? response.headers?.['Retry-After'];
        } catch {
          retryAfterValue = undefined;
        }
        const delay = providerRetryAfterMs(retryAfterValue);

        if (response.status === 401 && creds.mode === 'chatgpt' && !retried) {
          retried = true;
          try {
            await this.credentials.refresh();
          } catch (error) {
            const refreshInfo = await extractProviderError(error, {
              provider: options.provider ?? 'codex',
              model: options.model,
              status: response.status,
              requestId: id,
              diagnostics,
            });
            throw createProviderError(
              {
                ...refreshInfo,
                status: info.status ?? refreshInfo.status,
                requestId: info.requestId ?? refreshInfo.requestId,
                providerRetryAfterMs: delay ?? refreshInfo.providerRetryAfterMs,
                raw: [info.raw, refreshInfo.raw].filter(Boolean).join(' | '),
                message: refreshInfo.message ?? info.message,
                code: 'AUTH',
                classification: 'AUTH',
              },
              'Codex authentication refresh failed',
            );
          }
          continue;
        }

        if (delay !== undefined) info.providerRetryAfterMs = delay;
        throw createProviderError(info, 'Codex provider error');
      }

      if (!response.body) {
        throw createProviderError(
          {
            provider: options.provider ?? 'codex',
            model: options.model,
            status: Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : undefined,
            requestId: requestId(response.headers),
            message: 'Codex API returned an empty response body',
            code: 'EMPTY_RESPONSE',
            raw: '[empty response body]',
            diagnostics,
            classification: 'EMPTY_RESPONSE',
          },
          'Codex empty response',
        );
      }
      yield* translate(parseSse(response.body, onComment), {
        provider: options.provider ?? 'codex',
        model: options.model,
        requestedServiceTier: body.service_tier,
        diagnostics,
      });
      return;
    }
  }
}
