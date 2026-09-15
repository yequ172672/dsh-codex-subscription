# Changelog

## 0.2.0

## Unreleased — Codex Fast synthetic models

- 设计并实现 `base-model-fast` synthetic picker 行；Fast wire 值固定为 `service_tier: "priority"`，普通模型不发送 `service_tier`。
- 协议证据冻结参考：OpenAI Fast mode 文档（访问于 2026-03-19；文档页面标注支持 `priority`/`fast` 并说明响应可能返回 `default`）、Codex commits `7c0e54bf592bc12ef5ab14531b9732df4fc3803e` 与 `317213fd33fcbc76ae59817f9188033bb3569383`、DSH `0.1.2-rc.1` 实际类型定义。GitHub main/在线文档仍是动态来源，发布前应重新核对绑定版本。
- 保持默认 `clientVersion: 0.144.1`、唯一 `codex` provider route、现有 OAuth/401/SSE/proxy/tools/image 行为；不修改 DSH 核心标准请求类型。

## 0.1.7

- 适配 DSH `0.1.2-rc.1` 的 `ToolCallId` 与 Settings `installSection` API。
- 将 peer/dev 依赖更新到 DSH `0.1.2-rc.1`，不再错误声明兼容旧 Settings API。

## 0.1.6

- 保留 Codex 上游错误信息，不再将可识别故障归一化为无信息的 `provider error`。
- 支持嵌套 `error`、`data.error` 与 `response.failed.response.error` 字段。
- HTTP 错误保留 status、statusText、request id、retry-after 与有界 raw 摘要；响应正文只读取一次。
- 增加上下文超限、额度、限流、认证、请求、服务端、传输、超时和流关闭等稳定错误分类。
- 对 Authorization、Bearer、OAuth token、Cookie、JWT、prompt、messages、tool result 和图片数据做安全脱敏。
- 增加请求体字节数、输入项、工具输出大小、图片与 reasoning 等安全诊断指标；序列化失败提供明确错误。
- 补充 HTTP、SSE、脱敏、401 刷新和请求序列化测试。
