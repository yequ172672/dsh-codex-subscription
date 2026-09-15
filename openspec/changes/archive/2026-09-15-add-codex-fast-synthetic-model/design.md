## Context

本设计承接 `proposal.md` 与 `specs/codex-fast-synthetic-model/spec.md`。当前插件是纯 Host-side、自写 `fetch` + Responses SSE 适配器：`models.js` 把实时目录/cache/静态目录补全成模型条目，`adapter.js` 负责 provider route、模型解析、请求、401 refresh/retry 与 stream，`serialize.js` 直接把 `options.model` 写入请求体，`translate.js` 将 SSE 转为标准 `StreamChunk`。当前实现没有 service-tier 映射，也没有读取 `response.completed.response.service_tier`。

DSH `0.1.2-rc.1` 的实际类型确认了三个边界：`GenerateOptions` 已有 `purpose?: 'compaction' | 'session-title'`，但 `LlmCallConfig` 和 `ModelSelection` 没有 service tier；标准 `StreamChunk` 没有 service-tier 字段，不过 `finish` 允许插件私有 `replayState?: ReplayEnvelope`，其中 `response` 可携带 lossless JSON。`LlmAdapter.prepareCall()` 按冻结的 `LlmCallConfig` 解析 provider/model，具体 purpose 仍在后续 stream options 中可见，因此 service tier 必须由插件在 adapter/serialization dispatch 决定，不能依赖标准请求 waterfall 回写。

Codex main 当前 `ModelInfo` 同时暴露 `service_tiers`、`additional_speed_tiers`、context、input modalities 和 reasoning levels；Codex `ServiceTier::Fast` 的 request value 是 `priority`。官方 Fast 文档也说明请求可能因 ramp rate/额度/容量等原因返回 `service_tier: "default"`。这些动态来源必须在实施时绑定 commit/spec 版本：本提案引用 OpenAI 文档访问版本、`openai_models.rs` 与提交 `7c0e54bf592bc12ef5ab14531b9732df4fc3803e`、`317213fd33fcbc76ae59817f9188033bb3569383`，不把 GitHub main 的未来字段视为永久稳定 ABI。

## Goals / Non-Goals

**Goals:**

- 在插件目录层生成普通与 Fast synthetic rows，并让两者共享准确能力元数据。
- 将 picker ID 稳定地映射为基础 wire model 与可选顶层 `service_tier: "priority"`。
- 保持唯一 `codex` provider route、现有认证/代理/401/SSE/tools/图片/reasoning 行为。
- 对 actual tier 提供安全的 adapter-private/replay metadata，尤其识别 priority→priority 与 priority→default。
- 对实时、cache、static、内置 fallback 统一处理，且支持无配置迁移地回滚普通模型。
- 第一阶段只使用现有标准模型目录能力，不新增独立 Fast 设置、toolbar、Web 核心修改或 Client half。

**Non-Goals:**

- 不修改 DSH 核心、标准 `GenerateOptions`、`LlmCallConfig`、`ModelSelection`、Session Header、ModelSelect 或 `llm/stream` waterfall。
- 不直接复制 pi-ai `onPayload` 实现，也不引入新的适配器依赖。
- 不把所有请求默认改为 Fast，不支持所有未来 tier，不承诺实际 Fast 使用率/延迟。
- 不在本变更执行真实 Codex 请求、npm publish、生产修改或 3080 重启。

## Decisions

### 1. 把 service-tier 解析放在独立纯模块，模型能力生成留在 `models.js`

新增 `lib/service-tier.js`（名称可在实施时保持）承载无 I/O 的常量和纯函数：

- `CODEX_FAST_SUFFIX = '-fast'`；`CODEX_FAST_SERVICE_TIER = 'priority'`。
- `parsePickerModelId(id)`：从末尾移除至多一个 `-fast`，返回 `{ wireId, fast }`；不根据显示名称猜测。
- `resolveWireModel(id)`：普通 ID 返回 `{ wireId: id }`，Fast ID 返回 `{ wireId: base, serviceTier: 'priority' }`；未知 ID 保持相同规则。
- `applyWireTarget(body, target)`：复制请求对象并设置 `model`，只有 `serviceTier !== undefined` 时才增加 `service_tier`；不原地污染调用方 body。
- `supportsFast(entry)`：先认 `service_tiers` 对象的 `id === 'priority'`；若没有，才认旧数组精确值 `fast`；不把 `name === 'Fast'` 单独当作强证据，不接受未知 tier 自动升级。

选择独立模块而不是在 `serialize.js` 内散落后缀逻辑，是为了让目录归一化、`resolveModel()`、请求序列化、401 retry 和测试共享同一算法；也避免把 picker ID 误当作 wire model。`serialize.js` 仍负责消息/input/tools/reasoning 结构，只接收/使用已解析的 target。

### 2. 目录先归一化基础条目，再派生 Fast 条目

`models.js` 为每个来源条目先做 `normalizeCatalogEntry`/`completeEntry`：

- 保留 `id`、`name`、`description`、`input`、`contextWindow`、`maxTokens`、`defaultEffort`、`efforts`、图片/工具能力（当前 DSH 的工具能力由 adapter 默认支持，若目录提供显式信息则只做保守承载）。
- 从 live/cache 读取 `service_tiers`（保留最小 `{id,name,description}`）和 `additional_speed_tiers`；静态配置允许同样可选字段，但现有旧静态配置无需填写。
- 对已带 `-fast` 的来源 id，先拆出 base id，再将能力证据合并到基础条目；防止双后缀。
- 以源优先级和首次出现顺序稳定去重：显式 `staticModels` > live > cache > builtin 仍保持现有选择优先级；同一来源内按第一次基础条目顺序保留，后续条目只补充明确非空元数据，不覆盖已确认的能力为 false。
- 基础条目完成后，若 `supportsFast()` 为真，紧跟基础条目生成一个 `id: baseId + '-fast'` 的派生 entry。派生 entry 复制完整能力，`name` 使用已有显式 Fast 名称或 `${baseName} Fast`，`description` 可追加 service-tier 描述但不得带 token/request 内容。
- 为了与当前静态目录行为兼容，普通模型仍可接受无目录能力的未知 ID；这类未知普通 ID不生成目录 Fast 行。`resolveModel()` 对调用方显式传入未知 `-fast` 仍按明确的 mapping 规则解析，并使用安全默认能力。

这比把所有官方已知模型硬编码为 Fast 更安全：实时目录和用户 cache 可以阻止没有 Fast 资格的模型出现 synthetic 行，未来 tier 也不会被误判。

### 3. `listModels()`/`resolveModel()`/`prepareCall()` 的职责边界

- `listModels(provider)` 继续调用 `buildCatalog()`，但映射普通和派生 entry 的 `id/name/description/inputModalities`；不注册新 route。
- `resolveModel(provider, model, signal)` 从同一 catalog 查找 synthetic entry。若未找到，使用 `parsePickerModelId()` 的 base ID 和现有默认能力；若找到 Fast entry，完整返回继承后的 context/reasoning/input。Fast 后缀只保留在返回的 picker `id`，不在 `resolveModel()` 直接网络发送。
- `prepareCall()` 保持当前唯一 provider route 和核心 API 形状。若当前 DSH 基类默认实现只委托 `resolveModel()`，插件不增加标准 config 字段；如果实施需要显式覆盖，则只返回已解析 model info 与一个包装 stream 的闭包，仍由 `stream(options)` 根据 `options.purpose` 做 wire dispatch。
- `stream()`/`request()` 在一次请求开始时只解析一次 `target = resolveWireModel(options.model)`，并将 target 传给 serialization 和 translate context；重试循环复用不可变 target，不重新从不稳定上游目录推导。

### 4. 请求 mapping 在序列化完成后、fetch 前做最后一次纯投影

建议实现路径：`serializeRequest(options, ..., target)` 先构建现有请求 body，再由 adapter 根据 purpose 计算最终 target 并调用 `applyWireTarget`。这样消息序列化不需要知道目录，也不会把 picker ID泄漏到 `input` 或工具历史；服务 tier 是与 `model` 同级的顶层 Responses 字段。

普通 conversation：

```js
const target = resolveWireModel(options.model)
const effectiveTarget = options.purpose === 'compaction' || options.purpose === 'session-title'
  ? { wireId: target.wireId }
  : target
const body = applyWireTarget(await serializeRequestBody(options), effectiveTarget)
```

示例结果：

```js
resolveWireModel('gpt-5.6-luna')
// { wireId: 'gpt-5.6-luna' }

resolveWireModel('gpt-5.6-luna-fast')
// { wireId: 'gpt-5.6-luna', serviceTier: 'priority' }
```

`purpose` 安全策略在第一阶段固定为辅助请求降级到基础模型/default tier，不新增配置字段；这既避免 compaction/session-title 消耗 Fast quota，也不改变用户下一次普通 conversation 的 Fast 选择。普通模型始终没有 `service_tier`，即使其上游目录宣告支持 Fast。

### 5. actual tier 使用 `translate` 的终结上下文与 replay envelope

`request()` 将 `requestedServiceTier`（通常只有 Fast 才为 `priority`）放入 translate context，但不记录完整请求。`translate()` 在 `response.completed` 事件读取：

```js
const actual = event.response?.service_tier
```

仅接受有限、安全的字符串值；至少保存 `priority`、`default`，未知值可保存为受限字符串或归一化为 `unknown`。在 `finish` 之前组装：

```js
replayState: {
  response: {
    requestedServiceTier, // undefined for ordinary/default requests
    actualServiceTier,    // undefined when absent
    serviceTierStatus: requested === 'priority'
      ? actual === 'priority' ? 'fulfilled'
      : actual === 'default' ? 'downgraded'
      : 'unknown'
      : 'not-requested',
  },
}
```

只在有 service-tier 事实时添加 envelope，保持普通响应 metadata 最小化。`StreamChunk` 类型不改；`finish` 仍是现有标准 chunk，只多带已允许的 `replayState`。若 assembly/运行时未把 replay metadata暴露给当前 Web UI，则诊断仍可供 replay/adapter 内部使用，UI 暴露列为后续变更。

第一阶段不写独立 warning 日志：当前 `CodexAdapter` 没有稳定的用户通知 logger，且 warning 容易跨重试重复/泄漏上下文。降级状态通过私有 metadata 与安全、限长的 request diagnostics 记录；如现有 logger 接线在实施时已可用，可只输出 `model`、requested/actual/status/requestId 等白名单事实，绝不输出 prompt、token、完整响应或 body。

### 6. 重试、错误与现有安全诊断

- `requestDiagnostics()` 增加 `wireModel`、`pickerModel`（或只保留非敏感长度/状态）和 `requestedServiceTier`，并把 `serviceTier` 加入 `provider-error.js` 的允许白名单；不要把完整 body 放入 diagnostics。
- Fast mapping 在 body 建立前完成，401 refresh 只替换 credentials 并复用同一个 body/target；测试必须断言首发和重试一致。
- Fast 降级不是错误，不触发 retry，不改变 finish；`response.failed`、HTTP 400/401、SSE close 的现有分类保持不变。
- 如果服务端拒绝 `service_tier`，该请求按现有 INVALID_REQUEST 呈现；本变更不做隐式重试为普通模型，因为这会掩盖用户选择和额度/兼容性问题。用户可手动切回普通行。

### 7. UI、配置与版本策略

标准 DSH ModelSelect 从模型目录读取 `id/name/description/reasoning`，因此第一阶段不做 Client half；`listModels()` 的 synthetic rows 应直接成为 `GPT-5.6 Luna` / `GPT-5.6 Luna Fast` 两行。若在实施验证中发现 DSH `0.1.2-rc.1` 的实际前端目录缓存丢弃额外 rows，再创建独立后续 UI change，而不是扩大本次范围。

不新增 `fast` 配置开关或 `serviceTier` 字段。用户的旧 `agent-default-model.model: gpt-5.6-luna` 无迁移仍为普通模型；用户显式选择 `gpt-5.6-luna-fast` 后，session header 只保存既有 model string。回滚即重新选择基础 ID、删除/回退配置中的 `-fast` 后缀，或安装旧包；无需修改核心 schema。

`clientVersion` 继续默认 `0.144.1`，除非实施测试和源码证据证明端点拒绝 service tier 与版本有关，否则不改变。由于新增的是向后兼容能力而不是破坏性标准 API，发布评审应采用 minor bump（例如 `0.2.0`，实际版本以当前发布线和 package policy 确认），并在 README 增加配置示例、Fast premium/可能降级和诊断限制。实现前不 publish。

## Risks / Trade-offs

- **[动态目录字段变化]** → 绑定实现所用 Codex commit/spec 版本；解析器只依赖 `id`/legacy `fast` 的窄兼容面，未知 tier 保守不启用。
- **[后缀碰撞]** → 只解析末尾一个 `-fast`，对来源条目先归并基础 ID，并覆盖已带后缀/重复来源测试；显示名称不参与 wire mapping。
- **[未知显式 Fast ID 可能被用户误用]** → 允许 mapping 以保持历史适配器可用，但不在目录中自动展示未知 Fast 行，并在 README 说明上游可能拒绝未授权模型。
- **[Fast 额度/容量降级]** → 读取 response-level actual tier；不将请求意图当作事实，priority→default 标记 downgraded 且不失败请求。
- **[replay metadata 不一定到 Web UI]** → 只使用 DSH 已声明的 `finish.replayState`，不伪造标准 chunk 字段；Web 可视化列入后续增强。
- **[辅助请求继承选择的语义争议]** → 第一阶段固定 compaction/session-title 使用 base/default tier，减少配额意外消耗；如用户需要辅助请求 Fast，另立配置化变更并重新评审。
- **[静态目录能力不足]** → 静态条目必须显式增加 `serviceTiers`/legacy 字段才生成 Fast；不把现有所有静态模型默认升级为 Fast，普通用户行为保持不变。
- **[服务端不接受 priority]** → 保持首选协议事实但不自动降级重试；用户可切普通模型，错误保留现有安全 diagnostics。
- **[版本兼容]** → DSH `0.1.2-rc.1` 是验证基线，`clientVersion: 0.144.1` 保持；发布说明明确动态 Codex API 可能变化。

## Migration Plan

1. 实施前冻结并记录协议证据版本（OpenAI Fast 文档版本/日期、Codex commits、当前 package/DSH 版本），不执行真实请求。
2. 先加入纯 mapping 与目录归一化单元测试，再接入 adapter serialization/translate；每一步运行现有测试。
3. 对只读的静态/cache fixture 验证普通行与 Fast 行；对 mock SSE 验证 actual tier 和降级 metadata；对 mock 401 验证 mapping 保持。
4. 更新 README、变更日志/版本候选和 release notes；不改变现有配置默认值。
5. 发布后如需回滚，选择普通基础模型或回退 npm 包版本；Fast synthetic 配置不会污染普通 model ID，也不需要数据迁移。

## Open Questions

- 当前 DSH Web 的模型目录刷新时机是否总是实时调用 `listModels()`，仍需在实现阶段用现有 `0.1.2-rc.1` 安装组合做一次本地、非生产验证；若不满足，另起 UI change。
- 现有 session assembly 是否在所有消费端保留 `finish.replayState.response`，需要用本地 mock stream/replay fixture 验证；若某消费端丢弃它，后续可增加插件私有 Host diagnostics，但不能改标准 chunk。
