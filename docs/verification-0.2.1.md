# 0.2.1 验收记录

日期：2026-11-08。平台：Windows x64，Node.js 24.14.1，npm 11.21.1。

## 版本依据

- Codex CLI 最新稳定版：0.167.0；官方更新日志与 npm latest 标签一致。alpha 标签不作为本次兼容基线。
- DSH CLI 当前 latest：0.2.2-rc.1。隔离安装使用 Cordis 4.1.0、pnpm 10.34.9。
- 插件仍保留现有 dsh-llm / dsh-timeout 0.2.0-rc.2 依赖，避免未经验证的大范围依赖迁移。

## 已通过

1. `npm test`：60 项离线测试及旧宿主装载契约全部通过。
2. 对 lib/*.js、test/*.mjs 运行 `node --check`；`git diff --check` 无错误。
3. 发行 tgz 安装到独立 DSH_HOME / codex-test profile。官方 `dsh plugin add` 成功，bundle 自动加入 profile；`--dump-config` 包含 llm-codex。
4. 真实 Cordis Loader 按安装后的 profile 解析插件，LlmRuntime 注册 provider / 设置目录成功；prepareCall 正确解析模型上下文和默认参数。
5. prepared.stream 经真实宿主和已安装 adapter 消费模拟 SSE，正文、usage 和 stop 状态正确。
6. 真实 ChatGPT 后端模型目录返回 8 个可见模型，包括 GPT-6.1 Terra；GPT-6.1 Sol / Terra 当前目录上下文为 500,000。静态兜底使用该样本，不代表所有账号权益。
7. GPT-6.1 Sol 最小流式文本测试：返回“你好”，finish 为 stop，usage 正常。
8. 完整工具回合：模型请求 add_numbers(2, 3)，本地返回 5，回放工具结果后模型回答 5。

## 安全与测试范围

- 在线验收使用已存在的 Codex 文件登录。只发送固定测试输入，不读取私人会话，不打印 token、账号 ID 或凭据内容。
- 不写入 auth.json，不进行真实令牌刷新，避免轮换用户保存的刷新令牌。真实刷新失败和并发切换行为通过假凭据测试覆盖。
- 全程启用 TLS 校验；通过实际已配置的系统代理连接。未修改永久代理、TLS 或系统设置。
- 测试安装位于独立目录，未改动用户日常 DSH profile 或停止已有服务。

## 未覆盖与已知限制

- 完整桌面 UI、TUI、原生子进程功能未验收；部分 host 依赖安装脚本未运行，不将最小集成测试等同完整桌面安装验收。
- 新宿主可能出现插件旧 Cordis peer 范围警告，实际 Loader 与模型调用测试已通过；未据此宣称所有未来 DSH 版本兼容。
- 图片和系统 keyring / ephemeral 凭据不支持。
- GitHub Actions 已配置 Windows/Linux × Node.js 20/22/24 离线矩阵；每次提交的运行状态以 Actions 页面为准，CI 不使用真实账号。
- 本次发行只发布 GitHub Release，不发布 npm。

参考：[Codex 更新日志](https://learn.chatgpt.com/docs/changelog)、[Responses 流事件](https://developers.openai.com/api/reference/resources/responses/streaming-events)、[Codex 认证存储](https://learn.chatgpt.com/docs/auth)。
