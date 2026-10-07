# dsh-llm-codex

> 📦 已发布到 npm:[dsh-llm-codex](https://www.npmjs.com/package/dsh-llm-codex)(当前仓库版本 0.2.0)
> · 📚 GitHub:[yequ172672/dsh-codex-subscription](https://github.com/yequ172672/dsh-codex-subscription)
> · 🏷️ 属于 [dsh-plugin](https://github.com/topics/dsh-plugin) 插件话题

DSH(DeepSeek Harness)LLM 适配器插件:**直接复用 Codex CLI 的本地登录凭证**,在 DSH 中
使用 ChatGPT 订阅模型(gpt-6.1-sol 等),不需要 API Key。

这是一个标准的 **dsh 插件包**:包内 `dsh.bundle.patch` 声明使其成为 profile 层,
通过官方 `dsh plugin` 命令安装后**自动激活**,无需手工编辑任何 composition 文件。

## 版本兼容性

| 插件版本 | DSH 桌面端 | 宿主 dsh-llm | 配置模型 |
| --- | --- | --- | --- |
| 0.2.x | ≥ 44(0.2.0-rc.2) | 0.2.x | 导出 `Config` + 全字段 `.volatile()`,设置页自动生成 |
| 0.1.x | ≤ 43(0.1.0-rc.6) | 0.1.x | `settings.yaml` 的 `llm-codex:` 段 |

0.1.x 在 DSH ≥ 44 上会装载失败:宿主已删除 `settings.register`(设置服务重构为
表单投影),且 `LlmRuntime` 每次调用都会调用 0.1.x `LlmAdapter` 上不存在的
`prepareCall`。请使用 0.2.x。

**Codex wire 版本**:服务端按 `version` 头门控模型目录 —— 旧默认 `0.144.1` 只返回
旧目录且拒绝 `gpt-6.1-sol`(HTTP 400 "not supported … ChatGPT account");0.2.x 默认
已升到 `0.160.1`(2026-10 实测返回全量目录)。可用配置 `clientVersion` 覆盖。

## 搭配推荐:dsh-session-import-codex

配合 [dsh-session-import-codex](https://github.com/xing01l/session-import-codex) 使用
效果更佳:它把 Codex 的历史会话导入 DSH(会话 id 形如 `codex-<thread-id>`),与本插件的
"凭证/模型复用"互补 —— 在 DSH 里既能用 Codex 订阅模型对话,又能无缝续聊 Codex 里
开过的对话,实现"模型 + 历史"全链路打通。

```powershell
dsh plugin --profile web add dsh-session-import-codex
# 迁移(离线流程:先停止 dsh web 进程 → dry-run → 正式导入 → 重启 dsh)
pnpm --dir "$env:USERPROFILE\.dsh\profiles\web" exec dsh-import-codex --profile web --dry-run
pnpm --dir "$env:USERPROFILE\.dsh\profiles\web" exec dsh-import-codex --profile web
```

> ℹ️ `dsh-session-import-codex@0.1.1` 起已正确声明全部依赖,直接安装即可。

## 原理

Codex CLI(`codex login`)会把 ChatGPT 订阅的 OAuth 令牌写入 `~/.codex/auth.json`(或
`CODEX_HOME`)。本插件与 codex CLI **同源读取该文件**,并参照两个成熟实现
(参考实现:你的 [oh-my-pi-cn](https://github.com/yequ172672/oh-my-pi-cn) 与
[opencodex](https://www.npmjs.com/package/@bitkyc08/opencodex))的 wire 细节:

| 凭证形态 | 端点 | 认证 |
| --- | --- | --- |
| `tokens`(auth_mode: chatgpt,订阅) | `https://chatgpt.com/backend-api/codex/responses` | `Authorization: Bearer <access_token>` + `chatgpt-account-id` + `OpenAI-Beta: responses=experimental` + `originator: pi` + `version` |
| `OPENAI_API_KEY`(auth_mode: apikey) | `https://api.openai.com/v1/responses` | `Authorization: Bearer <api_key>` |

- **凭证热跟随**:每次请求都重新读 `auth.json`,CLI 登录/换号/登出,DSH 下一次请求自动生效。
- **令牌刷新**:access_token 过期(HTTP 401)时用 `refresh_token` 走
  `auth.openai.com/oauth/token` 刷新并自动重试一次;刷新成功后默认**原子写回**
  auth.json(`writeBack: false` 可关闭),与 codex CLI 行为一致,两边凭证永远同步。
- **模型目录**:优先实时拉取 `GET {base}/codex/models`,失败时回退
  `~/.codex/models_cache.json`,再回退内置静态列表。
- **协议**:OpenAI Responses API(`stream: true` SSE),推理摘要、正文、工具调用分别映射为
  DSH 的 reasoning / text / tool-call 块,usage 从 `response.completed` 提取。

## 目录结构

```
lib/
  index.js      插件入口(注册 provider "codex" + 目录条目 + volatile Config)
  adapter.js    CodexAdapter:fetch + SSE → StreamChunk(含 60s 模型目录缓存)
  auth.js       auth.json 读取 / 订阅令牌刷新 / 原子写回
  serialize.js  harness 消息 → Responses API 请求体
  translate.js  Responses SSE 事件 → StreamChunk
  sse.js        SSE 字节流解析(Responses 协议无 [DONE])
  models.js     模型目录:实时发现 → models_cache.json → 静态兜底
  transport.js  可选 HTTP CONNECT 代理(https-proxy-agent + node-fetch)
  constants.js  wire 常量(端点/头/上下文窗口)
cordis.bundle.yml   dsh.bundle 声明的 profile 层(插件行;安装后自动挂载)
test/serialize.mjs       请求序列化单元测试
test/apply-contract.mjs  0.2.0 宿主装载契约测试(离线)
test/smoke.mjs           端到端冒烟测试(只读,绝不写 auth.json)
test/version-probe.mjs   client_version 门控探针 + 最小流式对话
```

## 安装(dsh 官方插件命令)

### 前置条件

1. **已安装 dsh 本体**(本插件是 dsh 的 profile 层,必须先有 dsh):
   ```powershell
   npm install -g @deepseek-ai/dsh
   dsh --version   # 确认命令可用
   ```
   > 若提示 `无法将"dsh"项识别为 cmdlet…` / `dsh: command not found`,
   > 说明 dsh 尚未安装或不在 PATH,与插件无关。
2. **已安装 pnpm**(`dsh plugin` 会转发给它;缺失时 CLI 会提示)。
3. **已登录 Codex CLI**:`codex login`(插件直接复用其凭证,无需 API Key)。
4. **能访问 chatgpt.com**(国内网络通常需要代理,见下文"机器相关配置")。

### 安装插件

安装已发布的包:

```powershell
dsh plugin --profile web add dsh-llm-codex
```

本地开发直接加路径(pnpm 会以 `link:` 链接,改动即时生效):

```powershell
dsh plugin --profile web add D:\CODE\dsh\dsh-llm-codex
```

`dsh plugin` 做了什么:在 profile 目录里执行 `pnpm add <spec>`,然后把安装结果与
`dsh.profile.bundles` 层栈**自动 reconcile** —— 任何声明了 `dsh.bundle.patch` 的依赖
自动成为 profile 层,`update` 时新版本获得 bundle 声明也会自动激活,`remove` 后自动
移除。**无需手工编辑 cordis.patch.yml。**

> 💡 **版本范围建议**:请用**不带版本号**的方式安装(`add dsh-llm-codex`),pnpm 会保存
> `^x.y.z` 范围,之后的 `dsh plugin update` 能自动收取更新。若 profile 里依赖被写成
> 精确版本(例如 `"dsh-llm-codex": "0.1.0"`,常见于从本地 `link:` 依赖切换或显式指定
> 版本号的情况),`update` 会显示 "Already up to date" 而不会升级;重新执行一次不带
> 版本号的 `add` 即可回到范围跟踪。另外,刚发布的新版本可能触发 pnpm 的
> `minimumReleaseAge` 供应链策略(写入 pnpm-workspace.yaml 的排除清单或短暂提示),
> 属正常现象。

验证组合结果(不启动服务):

```powershell
dsh --profile web --dump-config   # 应看到 "# == dsh-llm-codex" 与 llm-codex 行
```

重启 dsh 后,Web 模型选择器出现 **Codex (ChatGPT 订阅)** provider,插件清单页
(设置 → 插件)也会列出 `llm-codex` 条目。

## 机器相关配置(不进包)

ChatGPT 后端通常需要走本地代理;Node 原生 fetch 不读系统代理。

**DSH ≥ 44(插件 0.2.x)**:`settings.yaml` 已退役 —— DSH 启动时会把旧
`settings.yaml` 的段一次性迁移到 profile entry 配置,之后配置入口有两个:

1. **设置页**(推荐):插件装载后 DSH 会按 `Config` 自动生成本插件的配置表单
   (字段全部 volatile,改动**热生效、无需重启**)。
2. **profile 组合文件** `~/.dsh/profiles/<name>/cordis.patch.yml`:

```yaml
- id: llm-codex
  name: dsh-llm-codex
  config:
    proxy: http://127.0.0.1:7890
```

也可用环境变量 `HTTPS_PROXY`(优先级:显式 `proxy` 配置 > `HTTPS_PROXY` >
`HTTP_PROXY`;`NO_PROXY` 命中的主机直连)。其他可选字段:`clientVersion`(默认
`0.160.1`)、`writeBack`(默认 `true`)、`streamIdleTimeoutMs`、`authFile`、
`modelsCacheFile`、`staticModels`(显式模型目录)。

选用 codex 作为默认模型(`cordis.patch.yml`):

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: codex
    model: gpt-6.1-sol
    reasoningEffort: medium
```

## 发布到 npm(dsh 插件库)

dsh 的"插件库"即 npm registry:`dsh.bundle.patch` 声明就是插件身份。

```powershell
npm login
npm publish            # 仓库目录内执行
# 任何机器上:
dsh plugin --profile web add dsh-llm-codex
dsh plugin --profile web update          # 升级所有 profile 插件
dsh plugin --profile web remove dsh-llm-codex   # 移除
```

发布前检查:`files` 字段含 `lib` 与 `cordis.bundle.yml`;`dsh.bundle.patch` 指向的
patch 文件只含插件行,不含任何机器相关的配置。

## 测试

```powershell
npm test                              # 序列化单元测试 + 0.2.0 装载契约测试
npm run test:smoke                    # 文本对话(默认模型 gpt-6.1-sol)
npm run test:smoke -- gpt-5.5         # 指定模型
npm run test:smoke -- gpt-6.1-sol --tools   # 额外验证工具调用路径
npm run test:probe                    # client_version 门控探针 + 最小流式对话
```

冒烟测试输出凭证形态、模型目录(实时拉取)、一次真实流式对话的结果与 usage。
测试默认只读(`writeBack: false`),绝不改写 auth.json;需要走代理时设置
`HTTPS_PROXY`(如 `http://127.0.0.1:7890`)。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `MISSING_CREDENTIAL:无法读取 Codex 凭证文件` | 先运行 `codex login` 登录 |
| `TRANSPORT:Connect Timeout` | 本机直连 ChatGPT 后端被墙;配置 `proxy`(见上文) |
| HTTP 401 且刷新失败 | 订阅过期或被风控;运行 `codex login` 重新登录 |
| HTTP 429 | 订阅额度/限流,稍后重试 |
| `INVALID_REQUEST:System messages are not allowed` | 系统提示已自动改走 `instructions` 字段,不应出现;如出现请升级插件 |
| `INVALID_REQUEST:Unsupported parameter` | 订阅后端拒绝 `max_output_tokens`/`temperature`/`stop`,适配器已自动剥离;如仍出现请升级插件 |
| `The 'gpt-6.1-sol' model is not supported … ChatGPT account` | `client_version` 太旧被服务端门控;升级插件(默认已 0.160.1)或把 `clientVersion` 配成与本机 codex 一致的版本 |
| 模型列表只有旧模型(gpt-5.6 系) | 实时发现被 0.144.1 旧版本头门控;同上调整 `clientVersion` |
| 模型列表为空 | 实时发现失败且 models_cache.json 不可读时使用内置静态列表 |

## 注意事项

- 本插件会读取并(在刷新时)改写 `~/.codex/auth.json`,与 codex CLI 行为一致;如不希望
  写回,设置 `writeBack: false`(届时过期令牌只在内存中刷新,重启 dsh 后重新刷新)。
- 适配器为文本 only:图片内容会以 `UNSUPPORTED_CONTENT` 拒绝。
- 订阅额度由 OpenAI 按账号计量,与 codex CLI 共用同一配额。
