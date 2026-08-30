# Changelog

## 0.1.6

- 保留 Codex 上游错误信息，不再将可识别故障归一化为无信息的 `provider error`。
- 支持嵌套 `error`、`data.error` 与 `response.failed.response.error` 字段。
- HTTP 错误保留 status、statusText、request id、retry-after 与有界 raw 摘要；响应正文只读取一次。
- 增加上下文超限、额度、限流、认证、请求、服务端、传输、超时和流关闭等稳定错误分类。
- 对 Authorization、Bearer、OAuth token、Cookie、JWT、prompt、messages、tool result 和图片数据做安全脱敏。
- 增加请求体字节数、输入项、工具输出大小、图片与 reasoning 等安全诊断指标；序列化失败提供明确错误。
- 补充 HTTP、SSE、脱敏、401 刷新和请求序列化测试。
