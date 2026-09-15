# codex-fast-synthetic-model Specification

## Purpose

让 DSH 用户把支持 Fast 的 Codex 基础模型作为一个独立、可选择且可回退的 synthetic 模型行使用，同时保持插件现有普通模型、SSE、重试与认证行为不变，并在不扩展 DSH 核心标准类型的情况下识别实际服务等级。

## Requirements

### Requirement: Fast capability produces explicit synthetic model rows

插件 SHALL 将一个上游模型视为支持 Fast，仅当其目录条目明确满足以下任一条件：`service_tiers` 中存在 `id === "priority"` 的对象，或在兼容旧目录时 `additional_speed_tiers` 数组包含精确值 `"fast"`。未知 service tier、仅有模糊名称、仅有未来 tier（例如 `ultrafast`）或缺少明确 Fast 证据的模型 MUST NOT 自动生成 Fast 行。

对每个支持 Fast 的基础模型，插件 SHALL 提供一个 `<base-id>-fast` synthetic picker ID；该 ID 不要求出现在上游目录中。Fast 行 SHALL 继承基础行的显示名称、描述、输入模态、context window、max tokens、reasoning efforts/default effort、图片能力和工具能力，并以稳定规则显示为基础名称加 `Fast`（例如 `GPT-5.6 Luna Fast`）。普通行仍以原始基础 ID 存在。

#### Scenario: Priority service tier creates a Fast row
- **WHEN** 一个实时、缓存或静态目录条目含有 `service_tiers: [{ id: "priority", name: "Fast", description: "..." }]`
- **THEN** 最终 `listModels()` 结果同时包含基础 ID 与 `<base-id>-fast`，且 Fast 行继承基础模型能力并显示 Fast 区分

#### Scenario: Legacy speed tier creates a compatible Fast row
- **WHEN** 目录条目没有 priority service tier，但 `additional_speed_tiers` 精确包含 `"fast"`
- **THEN** 插件按兼容回退生成一个 Fast 行，并保留可选的 service-tier 描述；其他未知 tier 不影响该判定

#### Scenario: Unsupported or ambiguous model has no Fast row
- **WHEN** 模型没有明确 priority 或 legacy fast 能力证据，或只声明 `ultrafast` 等未知 tier
- **THEN** 插件只提供基础行，不生成 `<base-id>-fast`

### Requirement: Synthetic IDs are normalized consistently across catalog sources

插件 SHALL 以 `base-model-fast` 作为统一 synthetic ID 约定，并在实时目录、`models_cache.json`、显式 `staticModels` 和内置静态目录上使用相同的能力补全、去重和排序规则。解析 SHALL 只在目录生成的 Fast 行、或调用方明确传入的合法 Fast synthetic ID 上识别后缀；模型原始名称/显示名称包含类似文字不应改变其 wire ID。已带 `-fast` 的原始模型 ID MUST NOT 产生双重 `-fast-fast` 行；同一基础 wire ID 的重复条目 MUST 只保留一个普通行和至多一个 Fast 行。

对未知模型 ID，插件 MUST 保持安全、可预测的兼容行为：普通未知 ID 映射到自身且不带 service tier；以 `-fast` 结尾的未知 ID 可解析为去掉一个后缀的 wire ID并请求 priority，但不得借此让目录中未宣告能力的普通模型自动出现 Fast 行，且该兼容规则必须可测试并在文档中说明。

#### Scenario: Sources merge without duplicate picker rows
- **WHEN** 实时目录、缓存或静态来源提供同一基础模型及其 Fast 变体的重复/不同顺序条目
- **THEN** 最终列表按稳定优先级去重，保留一个普通 picker 行和一个 Fast picker 行，且 `resolveModel()` 与 `listModels()` 返回一致能力

#### Scenario: Existing fast suffix is handled once
- **WHEN** 来源条目已经以 `model-fast` 形式出现，且基础目录也包含 `model`
- **THEN** 插件将其归并为同一个 Fast 变体，不生成 `model-fast-fast`，并将上游 wire ID规范化为 `model`

#### Scenario: Unknown IDs do not lose explicit mapping semantics
- **WHEN** 调用 `resolveModel()` 或 wire mapping 处理未知普通 ID 或未知 `unknown-fast`
- **THEN** 普通 ID 映射为 `{ wireId: "unknown" }`；`unknown-fast` 映射为 `{ wireId: "unknown", serviceTier: "priority" }`，同时未知 ID 的能力信息使用安全默认值，不阻塞请求解析

### Requirement: Model selection exposes Fast rows without changing DSH core types

插件 SHALL 通过现有 `codex` provider 的 `listModels()` 返回 Fast synthetic rows，使标准 DSH 模型目录/选择器可以像处理普通模型一样显示它们。插件 MUST NOT 注册第二个 provider route、修改 DSH 核心 ModelSelect、扩展标准 `GenerateOptions`、`LlmCallConfig`、`ModelSelection` 或 Session Header，也 MUST NOT 依赖修改 `llm/stream` waterfall 的冻结请求对象。

`resolveModel()` SHALL 通过 synthetic ID 查找基础 entry 并返回继承后的准确能力，而不能因为该 ID 不在上游目录中而退化为 text-only/默认 reasoning 能力。请求 dispatch SHALL 始终进入当前已注册的 `codex` provider，并保持代理、OAuth 401 refresh/retry、SSE、tools、图片和 reasoning 的现有路径。

#### Scenario: Standard selector receives ordinary and Fast rows
- **WHEN** DSH 读取 `codex` provider 的模型目录
- **THEN** 返回普通行和符合能力证据的 Fast 行，且无需 Client half 或核心 Web 修改即可显示其 ID、名称和输入模态

#### Scenario: Fast resolution inherits base capabilities
- **WHEN** `resolveModel("codex", "gpt-5.6-luna-fast")` 且基础目录声明 Luna 支持 image、tools、context 和 reasoning efforts
- **THEN** 解析结果保留这些能力、上下文和 reasoning 元数据，同时 ID 保持 synthetic picker ID

#### Scenario: Provider route remains singular
- **WHEN** 普通模型或 Fast 模型发起请求
- **THEN** 两者均使用 `codex` route 和现有端点/认证/代理/SSE 流程，不出现重复 provider 注册

### Requirement: Wire mapping sends priority only for explicit Fast rows

插件 SHALL 提供可测试的 picker-to-wire mapping：普通 `gpt-5.6-luna` 映射为 `{ wireId: "gpt-5.6-luna" }`；`gpt-5.6-luna-fast` 映射为 `{ wireId: "gpt-5.6-luna", serviceTier: "priority" }`。Responses 请求体 SHALL 使用基础 `wireId` 作为顶层 `model`，仅当 `serviceTier` 存在时添加顶层 `service_tier`；普通模型 MUST NOT 发送该字段，Fast synthetic ID MUST NOT 原样发送给上游。Fast 是 service tier，不得作为 reasoning effort 的别名或字段。

Fast mapping MUST only affect ordinary conversation generation by default. `purpose === "compaction"` 和 `purpose === "session-title"` 的安全策略 SHALL 强制使用基础 wire model 且不发送 `service_tier`，除非未来单独批准并实现配置化策略；第一阶段不增加独立 Fast 开关，也不默认把所有请求改为 Fast。

#### Scenario: Ordinary model omits service tier
- **WHEN** 普通模型序列化 Responses 请求
- **THEN** 请求包含 `model: "gpt-5.6-luna"` 且不包含 `service_tier`

#### Scenario: Fast model uses priority wire value
- **WHEN** `gpt-5.6-luna-fast` 作为普通 conversation 请求的 model
- **THEN** 请求包含 `model: "gpt-5.6-luna"` 与 `service_tier: "priority"`，且不包含 picker ID

#### Scenario: Auxiliary purpose avoids Fast quota by default
- **WHEN** 选择了 `gpt-5.6-luna-fast` 但请求 `purpose` 为 `compaction` 或 `session-title`
- **THEN** 请求使用 `gpt-5.6-luna` 且不含 `service_tier`，普通 conversation 后续请求仍按所选 Fast 行映射

### Requirement: Actual service tier is diagnosed without widening StreamChunk

插件 SHALL 从终结 SSE 事件 `response.completed.response.service_tier` 读取实际服务等级，并区分请求侧 `requestedServiceTier` 与响应侧 `actualServiceTier`。至少必须识别 priority→priority 成功和 priority→default 降级；缺失、非字符串或未知 actual tier MUST 保留为 unknown/undefined，而不能伪造 priority。Fast 降级 MUST 不改变正常文本、reasoning、tool-call、usage、finish 或 SSE 完成行为，但应在插件私有诊断中可见并可选择产生不含敏感内容的 warning。

诊断 SHALL 使用现有适配器私有 `finish.replayState.response`/脱敏 request diagnostics 或等价私有 metadata 传递，遵守 DSH `ReplayEnvelope` lossless-JSON 契约；不得向标准 `StreamChunk` 增加 `serviceTier` 字段，不得记录 prompt、messages、工具结果、图片、token 或完整响应。若当前运行时无法可靠把 actual tier 传到 Web UI，插件 MUST 记录为后端私有/replay 可用，并把 UI 展示列为后续增强而非伪造标准字段。

#### Scenario: Fast response confirms priority
- **WHEN** Fast 请求收到 `response.completed.response.service_tier = "priority"`
- **THEN** 完成 metadata 识别 `requestedServiceTier: "priority"` 和 `actualServiceTier: "priority"`，不改变标准流块

#### Scenario: Fast response is downgraded to default
- **WHEN** Fast 请求收到 `response.completed.response.service_tier = "default"`
- **THEN** 完成 metadata 识别降级，保留正常完成结果，并在安全诊断/warning 中说明 Fast 未实际使用但不泄漏请求内容

#### Scenario: Standard response has no tier
- **WHEN** 普通请求无 service tier 或终结事件缺少该字段
- **THEN** 普通响应不产生 Fast warning，actual tier 保持未定义/unknown，现有 SSE 解析和 finish 行为保持兼容

### Requirement: Refresh, cache, documentation and migration remain compatible

模型目录刷新 SHALL 继续按显式 staticModels、实时 `/codex/models`、`models_cache.json`、内置静态目录的既有优先级工作，并在每个来源应用相同 Fast 识别/归一化。401 refresh/retry MUST 重用同一 resolved target，使 Fast mapping 在重试请求中保持不变。现有普通模型配置 SHALL 继续解析并发送原有请求；选择普通模型即可回滚到无 service tier 的行为。README/配置说明 SHALL 解释 Fast 配额、可能因额度/容量/区域等原因降级、actual tier 诊断限制、默认 `clientVersion: 0.144.1` 未变以及旧配置无需迁移。

#### Scenario: 401 retry preserves Fast mapping
- **WHEN** Fast 请求首个请求返回 401，凭证刷新成功后进行一次重试
- **THEN** 首次与重试请求都使用基础 wire model 和 `service_tier: "priority"`，且不把 synthetic ID 泄漏给上游

#### Scenario: Cache and fallback preserve Fast behavior
- **WHEN** 实时目录失败并依次使用 cache 或静态 fallback
- **THEN** 只要 fallback 条目含明确 Fast 能力证据，Fast 行和 mapping 仍存在；否则不生成 Fast 行

#### Scenario: Existing user can roll back without migration
- **WHEN** 用户仍选择历史普通模型 ID 或切回同一基础模型
- **THEN** 配置保持可读，普通请求不含 `service_tier`，无需修改 session header 或核心模型选择结构
