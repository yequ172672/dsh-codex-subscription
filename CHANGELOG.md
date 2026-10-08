# Changelog

## 0.2.1 — DSH 0.2 image attachment fix

- 修复 DSH 0.2 `AttachmentStore.readImageRequest()` 参数不兼容：改为传入具体的 `width`、`height` 和 `maxBytes`，不再传旧式 `maxPixels`。
- 按图片原始尺寸和像素预算计算保持纵横比的请求图片目标。
- 增加大图投影尺寸回归测试；现有文本、工具、Fast、OAuth、错误和生命周期测试继续覆盖。

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
