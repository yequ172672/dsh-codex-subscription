# Changelog

## 0.2.3 — tool history and SSE hardening

- 过滤孤立、重复和乱序的 `function_call_output`，并拒绝缺少 `toolCallId` 的旧版嵌入式 `tool-result`，避免历史污染再次触发 Codex 请求拒绝。
- 修复嵌套 text-only 工具结果被错误降级为 `(no output)`；新增孤立输出、重复输出和安全诊断计数。
- 加固 Responses SSE 工具事件：支持 `function_call_arguments.done`，去重完整参数，补全 `output_item.done` 携带的 arguments，兼容 item id/call id 差异，校验缺失 id。
- 修复混合文本/工具响应错误返回 `stop`、`response.incomplete` 嵌套 reason 未识别、tool-call 诊断按 delta 而非调用计数等问题；保留 incomplete usage/service tier 元数据。
- 确保注入的 `fetchImpl` 同时用于 Codex 请求和凭证刷新，并防止未传 signal 时遮蔽原始传输错误。
- 新增多工具、图片、多工具往返真实回归验证；单元回归从 53 条扩展至 60 条。

## 0.2.2 — DSH 0.2 tool-result message fix

- **修复工具调用必然失败**:DSH 0.2 把工具结果提升为 `role: 'tool'` 的一等消息(`toolCallId` + `content`),而适配器此前只认 DSH 0.1 的「user 消息内嵌 `tool-result` 块」。结果是工具输出被当作普通 user 文本发出,请求里只有 `function_call` 而没有配对的 `function_call_output`;Codex 后端以**流内第一个事件**就是 `error` 的方式拒绝整个请求:`No tool output found for function call …`。现在 `role: 'tool'` 消息正确映射为 `function_call_output`,call id 仍经 `normalizeCallId` 保证与 `function_call` 配对一致。
- 保留 DSH 0.1 的 `tool-result` 块路径,两种历史形状都能序列化。
- 允许 `role: 'tool'` 结果消息携带图片(截图类工具);此前会被 `UNSUPPORTED_CONTENT` 误拒。`system`/`developer`/`assistant` 历史图片仍明确拒绝。
- DSH 0.2 的 `developer` 消息只剥离 `tool-addition` / `tool-removal` 声明块(本适配器每次请求下发完整工具表),其余正文不丢。
- 新增孤儿工具调用兜底:历史里出现没有结果配对的 `function_call`(工具未执行完、回合中断、上下文压缩丢弃结果)时丢弃该调用,而不是让整个会话被后端 400 永久锁死;诊断中新增 `orphanedToolCalls` 计数。
- 测试新增 10 条序列化用例(0.2 tool 消息配对、工具结果图片、空输出、developer 消息、孤儿调用、诊断计数),并在 `test/smoke.mjs --roundtrip` 增加真实凭证的工具往返回归 —— 该用例在修复前必然失败。
- 该版本属于 DSH 0.2 兼容线,建议使用 Git tag `v0.2.2` 固定安装;不兼容 DSH 0.1.x。

## 0.2.1 — DSH 0.2 image attachment fix

- 修复 DSH 0.2 `AttachmentStore.readImageRequest()` 参数不兼容：改为传入具体的 `width`、`height` 和 `maxBytes`，不再传旧式 `maxPixels`。
- 按图片原始尺寸和像素预算计算保持纵横比的请求图片目标。
- 增加大图投影尺寸回归测试；现有文本、工具、Fast、OAuth、错误和生命周期测试继续覆盖。
- 该版本属于 DSH 0.2 兼容线，建议使用 Git tag `v0.2.1` 固定安装；不兼容 DSH 0.1.x。

## 0.2.0 — DSH 0.2 migration

- **BREAKING:** 兼容基线迁移到 DSH `0.2.0-rc.2`，更新 `dsh-llm`、`dsh-settings`、`dsh-timeout` 和 Cordis peer/dev 依赖。
- 移除 DSH 0.1 的 `settings.installSection()` 使用，改用 DSH 0.2 插件 Config 与 Settings presentation policy。
- 为 Codex adapter 增加 `prepareCall()` 配置代次绑定，保证模型解析、transport、凭证和流式请求使用同一代配置。
- 保留现有 OAuth 刷新、Responses SSE、工具调用、图片输入、Fast service tier、错误分类和脱敏诊断行为。
- 增加 DSH 0.2 LLM runtime provider 注册/释放、重复路由、终止错误、取消和 metadata normalization contract tests。
- 迁移验证必须使用独立的 DSH 0.2 profile/实例；不重启或修改当前会话的 `http://127.0.0.1:3080`。

## Unreleased — Codex Fast synthetic models

- 设计并实现 `base-model-fast` synthetic picker 行；Fast wire 值固定为 `service_tier: "priority"`，普通模型不发送 `service_tier`。
- 协议证据冻结参考：OpenAI Fast mode 文档（访问于 2026-03-19；文档页面标注支持 `priority`/`fast` 并说明响应可能返回 `default`）、Codex commits `7c0e54bf592bc12ef5ab14531b9732df4fc3803e` 与 `317213fd33fcbc76ae59817f9188033bb3569383`、DSH `0.2.0-rc.2` 实际类型定义。GitHub main/在线文档仍是动态来源，发布前应重新核对绑定版本。
- 保持默认 `clientVersion: 0.144.1`、唯一 `codex` provider route、现有 OAuth/401/SSE/proxy/tools/image 行为；不修改 DSH 核心标准请求类型。

## 0.1.7

- 适配 DSH `0.1.2-rc.1` 的 `ToolCallId` 与 Settings `installSection` API（历史版本记录）。
- 将 peer/dev 依赖更新到 DSH `0.1.2-rc.1`，不再错误声明兼容旧 Settings API（历史版本记录）。

## 0.1.6

- 保留 Codex 上游错误信息，不再将可识别故障归一化为无信息的 `provider error`。
- 支持嵌套 `error`、`data.error` 与 `response.failed.response.error` 字段。
- HTTP 错误保留 status、statusText、request id、retry-after 与有界 raw 摘要；响应正文只读取一次。
- 增加上下文超限、额度、限流、认证、请求、服务端、传输、超时和流关闭等稳定错误分类。
- 对 Authorization、Bearer、OAuth token、Cookie、JWT、prompt、messages、tool result 和图片数据做安全脱敏。
- 增加请求体字节数、输入项、工具输出大小、图片与 reasoning 等安全诊断指标；序列化失败提供明确错误。
- 补充 HTTP、SSE、脱敏、401 刷新和请求序列化测试。
