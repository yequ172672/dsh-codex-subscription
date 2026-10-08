## Why

`dsh-llm-codex@0.2.0` 目前将 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-settings` 和 `@deepseek-ai/dsh-timeout` 限制在 `0.1.x`，因此无法通过 DSH `0.2.0-rc.2` 的插件兼容性检查。即使放宽版本范围，插件仍调用已从 DSH 0.2 移除的 `settings.installSection()`，会在激活阶段失败。本变更将 Codex 订阅适配器迁移到 DSH 0.2 的配置与 LLM 生命周期契约，并在独立 DSH 实例中验证，不触碰当前 3080 实例。

## What Changes

- 将插件的 DSH peer/dev 依赖和锁文件升级到 `0.2.0-rc.2` 兼容范围。
- **BREAKING** 移除对 DSH 0.1 Settings `installSection()` API 的调用，改用 DSH 0.2 的插件 Config 读取和 Settings 页面策略接口。
- 保留 `llm-codex` 配置命名空间、Codex provider 路由、模型发现、OAuth 刷新、SSE、代理、工具调用、图片输入和 Fast synthetic model 行为。
- 让模型解析与后续流式请求绑定到同一份配置代次，避免热更新期间元数据和 endpoint 混用。
- 增加针对 DSH 0.2 LLM 返回值校验、配置热更新、流终止、超时和真实 profile 组合的测试与验收步骤。
- 更新兼容性说明、迁移提示和发布版本策略。

## Capabilities

### New Capabilities

- `dsh-020-codex-adapter`: 在 DSH `0.2.0-rc.2` 运行时中注册并运行 Codex 订阅 LLM provider，包括配置、模型能力、流式调用和生命周期兼容行为。

### Modified Capabilities

<!-- 当前仓库没有已发布的主规格能力；本变更新增迁移后的 Codex adapter capability。 -->

## Impact

- 代码：`lib/index.js`、`lib/adapter.js`，以及必要的配置、认证、序列化、翻译和测试文件。
- 包清单：`package.json`、`pnpm-lock.yaml`、可能的 `CHANGELOG.md`/`README.md` 兼容说明。
- 运行时 API：依赖 DSH 0.2 的 `LlmAdapter`、`registerAdapter`、`registerConfigurableProviders`、`prepareCall`、`settings.configure` 和 `loader/volatile-update` 生命周期。
- 验证环境：创建新的独立 DSH 实例/profile，安装本地打包插件并进行组合/冒烟测试；不得自主重启当前会话的 `http://127.0.0.1:3080` 实例。
