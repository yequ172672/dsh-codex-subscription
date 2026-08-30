/**
 * Shared, bounded and secret-safe Codex provider error extraction.
 *
 * The upstream may report the same failure as an HTTP body, an SSE event,
 * response.failed, a JSON string, or a thrown Error. Keep the extraction in
 * one place so those paths cannot regress to a bare "provider error".
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmError,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm';

export const PROVIDER_ERROR_RAW_MAX_CHARS = 4_000;
const FIELD_MAX_CHARS = 1_000;
const DIAGNOSTICS_MAX_CHARS = 1_500;

const SECRET_KEY = /^(?:authorization|bearer|access[_-]?token|refresh[_-]?token|api[_-]?key|cookie|set[_-]?cookie|jwt|password|secret|prompt|messages|tool[_-]?result|input|image(?:_url|_data)?)$/i;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const LONG_TOKEN = /\b[A-Za-z0-9_+/=-]{96,}\b/g;
const SAFE_REQUEST_ID_MAX_CHARS = 256;

function redactSensitiveText(value) {
  let result = value.replace(BEARER, 'Bearer [REDACTED]').replace(JWT, '[REDACTED]');
  // Redact values for secret-bearing keys even when the upstream sent a
  // malformed (therefore non-JSON) payload. Quoted values cover JSON while
  // the second form covers common key=value error text.
  const jsonSecretKey = '(?:authorization|bearer|access[_-]?token|refresh[_-]?token|api[_-]?key|cookie|set[_-]?cookie|jwt|password|secret|prompt|messages|tool[_-]?result|input|image(?:_url|_data)?)';
  result = result.replace(new RegExp(`([\\"']?${jsonSecretKey}[\\"']?\\s*[:=]\\s*[\\"'])(?:\\\\.|[^\\"'])*([\\"'])`, 'gi'), '$1[REDACTED]$2');
  result = result.replace(new RegExp(`(${jsonSecretKey}\\s*[:=]\\s*)(?:Bearer\\s+)?([^,;\\s}]+)`, 'gi'), '$1[REDACTED]');
  // A long token-like atom is much more likely to be a credential than a
  // useful diagnostic. Human-readable messages with spaces are not matched.
  return result.replace(LONG_TOKEN, '[REDACTED]');
}

function safeString(value, limit = FIELD_MAX_CHARS) {
  if (typeof value !== 'string') return undefined;
  let result = redactSensitiveText(value);
  result = result.replace(/[\r\n\t ]+/g, ' ').trim();
  if (result.length === 0) return undefined;
  return result.length <= limit ? result : `${result.slice(0, limit - 1)}…`;
}

function safeKey(key) {
  return typeof key === 'string' ? key.slice(0, 120) : String(key);
}

/** Detach a small JSON-safe view without walking prompt/tool/image payloads. */
function sanitizeValue(value, depth = 0, seen = new WeakSet()) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return safeString(value, 600) ?? '';
  if (typeof value !== 'object') return `[${typeof value}]`;
  if (seen.has(value)) return '[Circular]';
  if (depth >= 4) return '[Nested value omitted]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1, seen));
    const output = {};
    for (const key of Object.keys(value).slice(0, 60)) {
      let child;
      try {
        child = value[key];
      } catch {
        child = '[Unreadable]';
      }
      output[safeKey(key)] = SECRET_KEY.test(key) ? '[REDACTED]' : sanitizeValue(child, depth + 1, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function safeRawSummary(value, limit = PROVIDER_ERROR_RAW_MAX_CHARS) {
  let rendered;
  if (typeof value === 'string') {
    rendered = safeString(value, limit);
  } else {
    try {
      rendered = JSON.stringify(sanitizeValue(value));
    } catch {
      rendered = '[unserializable upstream response]';
    }
    rendered = safeString(rendered, limit);
  }
  return rendered ?? '[empty upstream response]';
}

function readPath(value, path) {
  let current = value;
  for (const key of path) {
    if (current === null || current === undefined || (typeof current !== 'object' && typeof current !== 'function')) {
      return undefined;
    }
    current = safeRead(current, key);
  }
  return current;
}

function firstString(...values) {
  for (const value of values) {
    const result = safeString(value);
    if (result !== undefined) return result;
  }
  return undefined;
}

function safeRequestId(value) {
  const result = safeString(value, SAFE_REQUEST_ID_MAX_CHARS);
  return result === undefined ? undefined : result.slice(0, SAFE_REQUEST_ID_MAX_CHARS);
}

function safeRead(object, key) {
  if (object === null || object === undefined) return undefined;
  try {
    return object[key];
  } catch {
    return undefined;
  }
}

function firstNumber(...values) {
  for (const value of values) {
    const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d{3}$/.test(value) ? Number(value) : NaN;
    if (Number.isInteger(number) && number >= 100 && number <= 599) return number;
  }
  return undefined;
}

export function headerValue(headers, names) {
  if (!headers) return undefined;
  for (const name of names) {
    try {
      if (typeof headers.get === 'function') {
        const value = headers.get(name);
        if (value !== null && value !== undefined) return firstString(value, undefined);
      } else {
        const wanted = name.toLowerCase();
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === wanted) return firstString(headers[key], undefined);
        }
      }
    } catch {
      // A hostile/failing header implementation must not hide the body error.
    }
  }
  return undefined;
}

function errorObject(error) {
  if (!(error instanceof Error)) return error;
  const causeValue = safeRead(error, 'cause');
  let cause;
  if (causeValue instanceof Error) {
    cause = {
      name: safeRead(causeValue, 'name'),
      message: safeRead(causeValue, 'message'),
      code: safeRead(causeValue, 'code'),
    };
  } else if (causeValue !== undefined) {
    try {
      cause = String(causeValue);
    } catch {
      cause = '[unrenderable cause]';
    }
  }
  const failure = safeRead(error, 'failure');
  return {
    name: safeRead(error, 'name'),
    message: safeRead(error, 'message'),
    code: safeRead(error, 'code') ?? safeRead(failure, 'code'),
    status: safeRead(error, 'status') ?? safeRead(failure, 'status'),
    requestId: safeRead(error, 'requestId') ?? safeRead(failure, 'requestId'),
    providerRetryAfterMs: safeRead(failure, 'providerRetryAfterMs'),
    ...(cause === undefined ? {} : { cause }),
  };
}

function parsePayload(input) {
  if (input instanceof Error) return { value: errorObject(input), original: input };
  if (typeof input !== 'string') return { value: input, original: input };
  try {
    return { value: JSON.parse(input), original: input };
  } catch {
    return { value: undefined, original: input };
  }
}

function semanticDetail(info) {
  return [info.code, info.type, info.message, info.detail].filter(Boolean).join(' ');
}

/** Classify provider failures without changing the upstream code shown to users. */
export function classifyProviderError(info) {
  const detail = semanticDetail(info);
  const lower = detail.toLowerCase();
  const normalized = lower.replace(/[_-]+/g, ' ');
  if (info.status === 401 || info.status === 403) return 'AUTH';
  if (
    /context[ _-](?:length|window)[ _-](?:exceeded|overflow|limit)/i.test(detail) ||
    /(?:maximum|max)(?: allowed| supported)? context (?:length|window)/i.test(normalized) ||
    /(?:prompt|input|request|messages?) (?:is |are )?too (?:long|large)/i.test(normalized) ||
    /too many tokens|max prompt tokens|request exceeds (?:the )?(?:model )?context|message too big/i.test(normalized) ||
    /payload too large/i.test(normalized) && /context|token|prompt|input|message/i.test(normalized)
  ) return CONTEXT_WINDOW_EXCEEDED_CODE;
  if (
    /usage limit|quota exceeded|quota exhausted|billing limit|insufficient quota|account usage exhausted|chatgpt usage limit/i.test(normalized) ||
    /(?:balance|credits?) (?:exhausted|depleted)/i.test(normalized)
  ) return QUOTA_EXCEEDED_CODE;
  if (
    info.status === 401 || info.status === 403 ||
    /invalid token|token expired|failed to extract accountid|no account id in token|authentication failed|unauthorized|forbidden|oauth refresh/i.test(normalized)
  ) return 'AUTH';
  if (info.status === 429 || /rate limit|too many requests/i.test(normalized)) return 'RATE_LIMIT';
  if (info.status === 408 || info.status === 504 || /gateway timeout/i.test(normalized)) return 'TIMEOUT';
  if (info.status >= 500 && info.status <= 599 || /overloaded|service unavailable|upstream unavailable|server overloaded/i.test(normalized)) return 'SERVER';
  if (/request timeout|timed out|stream idle timeout|abortsignal timeout|response timeout|gateway timeout/i.test(normalized)) return 'TIMEOUT';
  if (info.code === 'STREAM_CLOSED' || /stream closed|sse stream ended/i.test(normalized)) return 'STREAM_CLOSED';
  if (/dns failure|econnreset|econnrefused|etimedout|socket closed|connection reset|network error|fetch failed|proxy connection error/i.test(normalized)) return 'TRANSPORT';
  if (info.code === 'INVALID_RESPONSE' || info.code === 'STREAM_PROTOCOL') return info.code;
  if (info.status === 400 || info.status === 413 || /unsupported parameter|invalid request|malformed request|invalid model|invalid tool schema|unsupported role|invalid input|payload too large/i.test(normalized)) return 'INVALID_REQUEST';
  return 'PROVIDER';
}

function structuredValue(value, context) {
  const error = readPath(value, ['error']);
  const response = readPath(value, ['response']);
  const responseError = readPath(response, ['error']);
  const dataError = readPath(readPath(value, ['data']), ['error']);
  const errorText = typeof error === 'string' ? safeString(error) : undefined;
  const responseErrorText = typeof responseError === 'string' ? safeString(responseError) : undefined;
  const dataErrorText = typeof dataError === 'string' ? safeString(dataError) : undefined;
  const message = firstString(
    readPath(value, ['message']),
    readPath(value, ['detail']),
    readPath(value, ['error']),
    readPath(error, ['message']),
    readPath(error, ['detail']),
    errorText,
    readPath(responseError, ['message']),
    readPath(responseError, ['detail']),
    responseErrorText,
    readPath(dataError, ['message']),
    readPath(dataError, ['detail']),
    dataErrorText,
  );
  const detail = firstString(
    readPath(value, ['detail']),
    readPath(error, ['detail']),
    readPath(responseError, ['detail']),
    readPath(dataError, ['detail']),
  );
  const code = firstString(
    readPath(value, ['code']),
    readPath(error, ['code']),
    readPath(responseError, ['code']),
    readPath(dataError, ['code']),
  );
  const type = firstString(
    readPath(value, ['type']),
    readPath(error, ['type']),
    readPath(responseError, ['type']),
    readPath(dataError, ['type']),
  );
  const status = firstNumber(
    context.status,
    readPath(value, ['status']),
    readPath(value, ['statusCode']),
    readPath(error, ['status']),
    readPath(error, ['statusCode']),
    readPath(responseError, ['status']),
    readPath(responseError, ['statusCode']),
    readPath(response, ['status']),
    readPath(dataError, ['status']),
    readPath(dataError, ['statusCode']),
  );
  const requestId = safeRequestId(firstString(
    context.requestId,
    readPath(value, ['request_id']),
    readPath(value, ['requestId']),
    readPath(error, ['request_id']),
    readPath(error, ['requestId']),
    readPath(responseError, ['request_id']),
    readPath(responseError, ['requestId']),
    readPath(response, ['request_id']),
    readPath(response, ['requestId']),
    readPath(dataError, ['request_id']),
    readPath(dataError, ['requestId']),
  ));
  return { message, detail, code, type, status, requestId };
}

/**
 * Extract one safe provider failure. HTTP-like inputs are read exactly once;
 * all other input forms are handled synchronously inside this async API.
 */
export async function extractProviderError(input, context = {}) {
  let source = input;
  let rawText;
  let responseStatus;
  let responseStatusText;
  let responseHeaders;
  if (input && typeof input === 'object' && typeof input.text === 'function' && 'status' in input) {
    responseStatus = input.status;
    responseStatusText = input.statusText;
    responseHeaders = input.headers;
    try {
      rawText = await input.text();
      source = rawText;
    } catch (error) {
      source = { message: `response body read failed: ${error?.message ?? error}`, code: 'BODY_READ_FAILED' };
    }
  }
  const parsed = parsePayload(source);
  const value = parsed.value;
  const raw = rawText !== undefined
    ? safeRawSummary(value === undefined ? rawText : value)
    : safeRawSummary(value ?? parsed.original);
  const inferred = structuredValue(value, {
    ...context,
    status: responseStatus ?? context.status,
    requestId: safeRequestId(context.requestId ?? headerValue(responseHeaders, ['x-request-id', 'x-req-id', 'x-client-request-id', 'request-id', 'trace-id', 'x-trace-id'])),
  });
  const info = {
    provider: firstString(context.provider) ?? 'codex',
    status: inferred.status,
    statusText: firstString(context.statusText, responseStatusText),
    code: inferred.code,
    type: inferred.type,
    message: inferred.message ?? (value === undefined && typeof parsed.original === 'string' ? safeString(parsed.original) : undefined),
    detail: inferred.detail,
    requestId: safeRequestId(inferred.requestId),
    raw,
    diagnostics: context.diagnostics,
  };
  if (info.message === undefined) {
    info.message = info.code ?? info.type ?? 'unrecognized upstream error';
  }
  info.classification = classifyProviderError(info);
  return info;
}

function safeDiagnostics(value) {
  if (!value || typeof value !== 'object') return undefined;
  const selected = {};
  const allowed = new Set([
    'model', 'requestBytes', 'inputItems', 'messageCount', 'toolCount', 'largestToolResultChars',
    'totalToolResultChars', 'hasImages', 'imageCount', 'contextWindow', 'reasoning',
    'reasoningEffort', 'maxOutputTokens', 'imagesCropped', 'streamEvents',
    'streamStarted', 'streamHadText', 'streamToolCalls',
  ]);
  for (const key of allowed) {
    const item = value[key];
    if (item !== undefined && item !== null && item !== '') selected[key] = item;
  }
  // Diagnostics are generated by this package, so their numeric facts should
  // remain visible instead of being mistaken for request fields by redaction.
  let rendered;
  try {
    rendered = JSON.stringify(selected);
  } catch {
    rendered = undefined;
  }
  if (typeof rendered !== 'string' || rendered === '{}') return undefined;
  return safeString(rendered, DIAGNOSTICS_MAX_CHARS);
}

/** Render a user-facing message while retaining bounded upstream diagnostics. */
export function formatProviderError(info, prefix = 'Codex provider error', extra = []) {
  const parts = [safeString(prefix, 120) ?? 'Codex provider error'];
  const add = (label, value, limit = FIELD_MAX_CHARS) => {
    const safe = safeString(value, limit);
    if (safe !== undefined) parts.push(`${label}=${safe}`);
  };
  add('provider', info.provider ?? 'codex', 120);
  if (Number.isInteger(info.status) && info.status >= 100 && info.status <= 599) parts.push(`status=${info.status}`);
  add('statusText', info.statusText, 120);
  add('code', info.code, 160);
  add('type', info.type, 160);
  add('requestId', info.requestId, SAFE_REQUEST_ID_MAX_CHARS);
  add('message', info.message ?? info.detail ?? 'unrecognized upstream error', FIELD_MAX_CHARS);
  for (const item of extra) {
    if (item && typeof item.label === 'string') add(item.label.slice(0, 80), item.value, FIELD_MAX_CHARS);
  }
  if (info.raw !== undefined) add('raw', info.raw, PROVIDER_ERROR_RAW_MAX_CHARS);
  const diagnostics = safeDiagnostics(info.diagnostics);
  if (diagnostics !== undefined) parts.push(`diagnostics=${diagnostics}`);
  return parts.join('; ');
}

export function providerErrorOptions(info, extra = {}) {
  return {
    ...(Number.isInteger(info.status) && info.status >= 100 && info.status <= 599 ? { status: info.status } : {}),
    ...(safeRequestId(info.requestId) === undefined ? {} : { requestId: safeRequestId(info.requestId) }),
    ...(Number.isFinite(info.providerRetryAfterMs) && info.providerRetryAfterMs > 0 ? { providerRetryAfterMs: info.providerRetryAfterMs } : {}),
    ...extra,
  };
}

export function createProviderError(info, prefix, extra = {}) {
  const extraLabels = Array.isArray(extra) ? extra : [];
  const extraOptions = Array.isArray(extra) ? {} : extra;
  return new LlmError(
    formatProviderError(info, prefix, extraLabels),
    info.classification ?? classifyProviderError(info),
    providerErrorOptions(info, extraOptions),
  );
}
