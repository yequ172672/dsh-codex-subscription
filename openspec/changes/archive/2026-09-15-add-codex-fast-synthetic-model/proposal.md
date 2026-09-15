## Why

`dsh-codex-subscription` 当前已通过自写 Responses API + SSE 适配器复用 Codex CLI 的 ChatGPT OAuth 订阅能力，但上游请求体没有发送 Codex Fast 所需的顶层 `service_tier`。这使用户只能选择普通模型，无法在不修改 DSH 核心 `GenerateOptions`、`LlmCallConfig`、`ModelSelection` 或 Web ModelSelect 的前提下显式选择 Fast，也无法验证服务端是否因额度、容量或区域而降级。现在采用插件拥有的 synthetic model ID，将 Fast 作为独立模型行表达，能保持普通模型兼容并避开冻结的标准配置链路。

## What Changes

- 为明确宣告 Fast 能力的基础模型生成独立的 `base-model-fast` picker/synthetic 行；Fast 行继承基础模型的名称、描述、输入模态、上下文窗口、输出上限、reasoning efforts、图片和工具能力。
- 统一解析实时 `/codex/models`、`models_cache.json` 和静态目录，兼容 `service_tiers[].id === "priority"` 以及旧目录 `additional_speed_tiers` 含 `"fast"` 的回退判定；未知 tier 不自动视为 Fast。
- 将 synthetic picker ID 在插件内部解析为 `{ wireId, serviceTier }`，普通行只发送基础 wire model，Fast 行发送基础 wire model 与顶层 `service_tier: "priority"`，绝不把 `-fast` ID 发给上游。
- 调整 `listModels()`、`resolveModel()`、请求 dispatch/序列化和 `prepareCall()` 的插件内部行为，同时继续只注册现有 `codex` provider route，保持 OAuth、401 刷新重试、代理、Responses SSE、tools、图片与 reasoning 行为兼容。
- 为 `response.completed.response.service_tier` 增加插件私有请求/响应诊断与 replay metadata 设计，区分 `requestedServiceTier`、`actualServiceTier` 和降级；不向标准 `StreamChunk` 增加 service-tier 字段。
- 明确 `purpose === "compaction"` 与 `purpose === "session-title"` 的第一阶段安全策略，避免辅助请求无意消耗 Fast 配额，并覆盖 synthetic 选择在辅助调用中的继承/回退行为。
- 以现有标准 ModelSelect 直接消费 adapter `listModels()` 为首选，不新增 Fast 开关、toolbar、Client half 或 DSH Web 核心改动；只有验证标准目录无法显示额外行时，另立后续 UI 变更。
- 增加 README 中的 Fast 选择、降级、配额、迁移和回滚说明，并在不改变默认 `clientVersion: 0.144.1` 的前提下补充兼容性说明。
- 增加模型目录、wire mapping、序列化、SSE/diagnostic、重试、辅助 purpose 和兼容回归测试；不执行真实 Codex 请求。

## Capabilities

### New Capabilities

- `codex-fast-synthetic-model`: 通过插件内部 synthetic model 行提供 Codex Fast 模型发现、能力继承、wire service-tier 映射和实际服务等级诊断，而不扩展 DSH 核心标准模型或请求类型。

### Modified Capabilities

- 无。仓库当前没有已发布的 `openspec/specs/` 能力规范；本变更以新能力规范定义适配器对外可观察行为。

## Impact

- 主要代码面：`lib/models.js`、`lib/serialize.js`、`lib/adapter.js`、`lib/translate.js`、必要时新增 `lib/service-tier.js`；可能更新 `lib/index.js` 的配置/诊断接线、`lib/provider-error.js` 的安全诊断白名单、`lib/constants.js` 的 wire 常量。
- 测试面：扩展 `test/serialize.mjs`、`test/models.mjs`、`test/errors.mjs`、`test/index.mjs`，必要时新增诊断/重试测试文件；保留 `test/smoke.mjs` 为显式、真实网络的手工冒烟，不在本变更中运行真实请求。
- 文档与发布面：`README.md`、`package.json` 的版本策略和配置示例；第一阶段预计 minor bump（若实现仅被判定为兼容增量也需由发布评审确认），不发布 npm、不修改生产环境、不重启 3080。
- DSH 兼容边界：以 DSH `0.1.2-rc.1` 实际类型为准。`GenerateOptions` 仅有 `purpose`、`model`、`reasoningEffort` 等现有字段；`StreamChunk.finish` 已允许插件私有 `replayState`/`ReplayEnvelope`，可承载脱敏 response metadata。`ModelSelection`、`LlmCallConfig` 和标准 Web ModelSelect 保持不变。
- 协议依据：OpenAI Fast mode 文档、Codex GitHub main 与 `openai_models.rs`、以及提交 `7c0e54bf592bc12ef5ab14531b9732df4fc3803e` 和 `317213fd33fcbc76ae59817f9188033bb3569383`。这些是动态来源，实施和发布前必须绑定/记录具体 commit 或 OpenAPI/spec 版本，不能将 GitHub main 的未来字段当作当前稳定保证。
