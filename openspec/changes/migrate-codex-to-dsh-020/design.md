## Context

参见 `proposal.md` 的 Why 与 Impact。本仓库当前插件入口在 `apply(ctx, config)` 中维护 `current()` 配置读取器，并通过 DSH 0.1 的 `settings.installSection()` 把 Settings 段变化回写到该读取器。DSH `0.2.0-rc.2` 已移除该 API；其官方 LLM 适配器直接消费插件 Config，并在需要时通过 `settings.configure({ auto: false }, ownerFiber)` 控制设置页面生成策略。0.2 的 LLM runtime 还会严格校验 provider/model metadata，并支持把一次 `prepareCall()` 绑定到一个适配器配置代次。

本次迁移必须保持当前 Codex 的单 provider 路由、动态凭证、代理传输、SSE 翻译、图片和 Fast tier 行为，同时只能在新的独立 DSH 实例/profile 验证，不能重启或改写当前会话的 3080 服务。

## Goals / Non-Goals

**Goals:**

- 让 npm manifest 和锁文件被 DSH `0.2.0-rc.2` 接受。
- 用 DSH 0.2 的插件 Config/Settings 生命周期替换 `installSection()`。
- 保持 `llm-codex` 配置 namespace 与 profile bundle 入口，使现有用户配置可以迁移。
- 在一次已准备的模型调用中固定解析后的配置、transport 和凭证读取代次。
- 覆盖 DSH 0.2 对 provider、model、stream finish 和生命周期的验证要求。
- 提供可重复的独立 profile 安装与冒烟验收路径。

**Non-Goals:**

- 不修改 Codex 上游 Responses/SSE 协议或重新设计 OAuth 凭证格式。
- 不新增 Web Client、Typert Remote、Tool 或新的 provider route。
- 不改变当前 3080 DSH 实例的进程、配置、端口或运行状态。
- 不为旧 DSH 0.1 继续维持同一发布版本的运行时兼容；如需兼容旧版本，应通过独立的历史插件版本处理。

## Decisions

### 1. 将 DSH 0.2 作为单一发布基线

插件的 peerDependencies、devDependencies 与 lockfile 统一使用 `0.2.0-rc.2` 系列，并同步 `@deepseek-ai/cordis` 的宿主范围。这样兼容性声明与测试运行时一致，避免“manifest 声明兼容、开发测试仍运行旧 API”的假阳性。

替代方案是把 peer range 同时扩到 0.1 与 0.2；不采用，因为 Settings API 在两个版本间存在删除式不兼容，单一入口无法在没有运行时分支的情况下安全支持两套语义。

### 2. 直接消费插件 Config，Settings 仅用于页面策略

保留现有 `Config` schema 和 `apply(ctx, config)` 参数，把 `config` 作为 DSH 0.2 的配置事实来源；删除 `installSection()`、`setSource` 和旧 Settings change callback。可选 Settings service 只注册 `configure({ auto: false }, ctx.fiber)`，避免 0.2 的自动表单生成策略改变现有插件行为。

替代方案是自行读取 Settings descriptor 或调用 0.2 的 `describe/update/replace`；不采用，因为这些是配置表面/写入 API，不是业务插件消费自身 Config 的推荐路径，也会引入秘密字段和修订号处理责任。

### 3. 把配置快照传给一次 Codex 调用

保留 `options()` 作为下一次请求的动态解析入口，但为 `CodexAdapter.prepareCall()` 捕获一次已解析的配置快照，并让返回的 `stream()` 使用该快照创建 transport、读取 credentials、序列化请求和执行 timeout。普通 `stream()` 继续读取当前配置，供未经过 prepare 的直接调用和测试使用。

替代方案是只依赖基类默认 `prepareCall()`；不采用，因为基类默认实现会在 dispatch 时重新调用动态 `stream()`，无法保证模型解析与请求 transport 属于同一配置代次。

### 4. 仅在注册事实改变时替换路由

Codex 的请求级字段仍由每次调用读取，不因普通配置变化而删除再注册 provider。只有确实影响注册元数据或未来扩展的注册级事实变化时才使用 DSH 0.2 的原子 registration handle；配置更新监听若需要保留，应监听 0.2 的 `loader/volatile-update`，并避免产生路由短暂空窗。

替代方案是每次配置变化都 `registration.replace([PROVIDER])`；不采用，因为 Codex 当前 provider identity 不随配置变化，额外替换会增加并发调用与 HMR 的复杂度而不提供可观察收益。

### 5. 保留现有流翻译和安全诊断边界

不重写 `translate.js`、`provider-error.js` 或认证/序列化协议，只将其异常和 chunk 输出放入 DSH 0.2 的最终适配器边界测试。重点验证 `usage` 先于 `finish`、工具参数保持原始 JSON delta、finish/replayState 为可序列化值、错误诊断不包含 prompt/token/image。

替代方案是依赖 DSH 0.2 自动吞掉所有 adapter 异常；不采用，因为 Codex 现有 provider-specific status、request id、retry-after 和脱敏 raw summary 是用户诊断的一部分。

## Risks / Trade-offs

- **[Risk]** DSH 0.2 对模型 reasoning、context 和 modality metadata 的校验比旧版严格。→ **Mitigation:** 为 catalog/resolveModel 增加契约测试，覆盖静态模型、动态目录、Fast synthetic row 和未知模型 fallback。
- **[Risk]** 配置对象在 Cordis reload 后可能被替换，旧引用可能继续服务。→ **Mitigation:** 下一次调用通过当前 Config 事实重新解析；prepared call 使用独立快照；在 volatile reload 测试中断言新旧代次隔离。
- **[Risk]** 删除 `installSection()` 后设置页面的自动生成策略发生变化。→ **Mitigation:** 显式使用可选 `settings.configure({ auto: false }, ctx.fiber)`，并在有/无 Settings service 两种组合中验证 provider 仍可启动。
- **[Risk]** 0.2 的包锁定、Cordis peer 或桌面 profile 解析与仓库开发依赖不一致。→ **Mitigation:** 以 `pnpm install` 后的实际版本、`pnpm pack --dry-run`、独立 profile 安装和 `dump-config` 为验收门槛。
- **[Risk]** 独立 DSH 测试可能误连当前 3080 服务或复用其 profile。→ **Mitigation:** 使用显式独立 DSH home/profile、独立端口/进程记录和只读 dump/controlled smoke 命令；测试脚本禁止调用当前实例重启路径。
- **[Risk]** 订阅端点或本地 Codex 凭证不具备稳定可用的网络条件。→ **Mitigation:** 默认先使用 stubbed fetch/fixture 完成协议测试；真实 smoke 作为独立环境中的可选步骤，writeBack 默认关闭或显式设置为 false。

## Migration Plan

1. 在 `codex-dsh-0.2.0-rc.2` 分支更新 manifest、lockfile、入口生命周期和 adapter prepared-call 逻辑。
2. 运行既有单元测试，并补齐 DSH 0.2 runtime contract、config reload、lifecycle dispose 和 package archive 测试。
3. 执行 `pnpm pack --dry-run`，确认 bundle patch 与 lib 文件均在包内。
4. 创建新的独立 DSH 0.2 profile/实例，安装本地包或 tarball，执行 `dump-config`、provider/model listing 和受控 stream smoke；不触碰当前 3080 服务。
5. 失败时只在本分支修复；如需回滚，回到本次改动前的插件版本或移除独立测试 profile，不回滚/重启当前会话实例。

## Open Questions

无。适配基线、Settings 迁移策略、调用代次边界和独立测试隔离均已在本设计中确定。
