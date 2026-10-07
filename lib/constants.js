/**
 * OpenAI Codex / ChatGPT 订阅后端的 wire 常量。
 *
 * 取值对齐两个已被验证的实现:
 * - oh-my-pi-cn(https://github.com/yequ172672/oh-my-pi-cn)`packages/catalog/src/wire/codex.ts`
 * - opencodex(@bitkyc08/opencodex)`src/providers/openai-tiers.ts`
 */

/** ChatGPT 订阅(Codex CLI 登录,`auth_mode: chatgpt`)后端根地址。 */
export const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api';

/** 官方 API key 模式(`auth_mode: apikey`)后端根地址。 */
export const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';

/** ChatGPT OAuth 令牌刷新端点(refresh_token grant)。 */
export const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';

/** Codex CLI / ompcn 共用的 OAuth client id。 */
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** 默认 codex CLI wire 版本(与 @openai/codex 发布版本对应)。
 *  服务端按 `version` 头门控模型目录:0.144.1 只返回旧目录且拒绝 gpt-6.1 系,
 *  0.160.1 实测返回全量目录(2026-10 验证);可用配置 clientVersion 覆盖。 */
export const DEFAULT_CODEX_CLIENT_VERSION = '0.160.1';

/** ChatGPT 订阅模式的关键请求头。 */
export const CODEX_HEADERS = {
  ACCOUNT_ID: 'chatgpt-account-id',
  BETA: 'OpenAI-Beta',
  ORIGINATOR: 'originator',
  VERSION: 'version',
  CONVERSATION_ID: 'conversation_id',
  SESSION_ID: 'session_id',
  REQUEST_ID: 'x-client-request-id',
};

export const CODEX_HEADER_VALUES = {
  BETA_RESPONSES: 'responses=experimental',
  ORIGINATOR: 'pi',
};

/** 默认上下文窗口与最大输出(与 Codex 目录 2026-10 实测对齐)。 */
export const DEFAULT_CONTEXT_WINDOW = 272_000;
/** GPT-6.1 系列实测上下文(Codex 目录对 gpt-6.1-sol 返回 800000)。 */
export const GPT_6_1_CONTEXT_WINDOW = 800_000;
export const DEFAULT_MAX_TOKENS = 128_000;
