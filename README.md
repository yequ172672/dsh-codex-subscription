# dsh-llm-codex

> 📦 已发布到 npm:[dsh-llm-codex@0.1.6](https://www.npmjs.com/package/dsh-llm-codex)
> · 📚 GitHub:[yequ172672/dsh-codex-subscription](https://github.com/yequ172672/dsh-codex-subscription)
> · 🏷️ 属于 [dsh-plugin](https://github.com/topics/dsh-plugin) 插件话题

本仓库名称为 `dsh-codex-subscription`，发布到 npm 的包名为 `dsh-llm-codex`。

DSH(DeepSeek Harness)LLM 适配器插件:**直接复用 Codex CLI 的本地登录凭证**,在 DSH 中
使用 ChatGPT 订阅模型(gpt-5.6-sol 等),不需要 API Key。

这是一个标准的 **dsh 插件包**:包内 `dsh.bundle.patch` 声明使其成为 profile 层,
通过官方 `dsh plugin` 命令安装后**自动激活**,无需手工编辑任何 composition 文件。

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
  provider-error.js  统一上游错误提取、分类、脱敏与诊断
  index.js      插件入口(注册 provider "codex" + 可配置 provider 目录 + 设置段)
  adapter.js    CodexAdapter:fetch + SSE → StreamChunk(仿 dsh-llm-deepseek)
  auth.js       auth.json 读取 / 订阅令牌刷新 / 原子写回
  serialize.js  harness 消息 → Responses API 请求体
  translate.js  Responses SSE 事件 → StreamChunk
  sse.js        SSE 字节流解析(兼容 Responses 与 [DONE])
  models.js     模型目录:实时发现 → models_cache.json → 静态兜底
  transport.js  可选 HTTP CONNECT 代理(https-proxy-agent + node-fetch)
  constants.js  wire 常量(端点/头/上下文窗口)
cordis.bundle.yml   dsh.bundle 声明的 profile 层(插件行;安装后自动挂载)
test/serialize.mjs  请求序列化单元测试
test/models.mjs     模型能力目录与适配器能力单元测试
test/index.mjs      单元测试入口(避免 Windows 测试运行器额外 spawn)
 test/errors.mjs      HTTP/SSE 错误提取、分类与脱敏测试
test/smoke.mjs      端到端冒烟测试(只读,绝不写 auth.json)
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

### DSH 版本兼容性

从 `0.1.3` 开始，DSH 核心包作为宿主 peer dependency 使用，不再在插件中固定安装
`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-settings` 和 `@deepseek-ai/dsh-timeout` 的旧版本。
该版本兼容 DSH `0.1.0-rc.6` 至 `0.1.0-rc.8`，以及 `0.1.1-rc.1` 和
`0.1.1-rc.2`。

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

如果从 `0.1.2` 或更早版本升级，旧版本可能已经在 profile 中安装了
`@deepseek-ai/dsh-llm@0.1.0-rc.6`。建议先移除旧插件，再安装新版本，避免旧依赖残留：

```powershell
dsh plugin --profile web remove dsh-llm-codex
dsh plugin --profile web add dsh-llm-codex
```

验证组合结果(不启动服务):

```powershell
dsh --profile web --dump-config   # 应看到 "# == dsh-llm-codex" 与 llm-codex 行
```

重启 dsh 后,Web 模型选择器出现 **Codex (ChatGPT 订阅)** provider,插件清单页
(设置 → 插件)也会列出 `llm-codex` 条目。

## 机器相关配置(settings.yaml,不进包)

ChatGPT 后端通常需要走本地代理;Node 原生 fetch 不读系统代理,在
`$DSH_HOME/settings.yaml` 配置:

```yaml
llm-codex:
  proxy: http://127.0.0.1:7890
```

也可用环境变量 `HTTPS_PROXY`(优先级:显式 `proxy` 配置 > `HTTPS_PROXY` >
`HTTP_PROXY`;`NO_PROXY` 命中的主机直连)。其他可选字段:`clientVersion`(默认
`0.144.1`)、`writeBack`(默认 `true`)、`authFile`、`modelsCacheFile`、
`staticModels`(显式模型目录)。图片请求还可配置:

```yaml
llm-codex:
  maxRequestImageBytes: 20971520   # 单次请求图片 Base64 总预算,默认 20 MiB
  requestImagePixelBudget: 4194304 # 单张图片最大像素,默认 2048 × 2048
  requestImageMaxBytes: 1048576    # 单张请求版本最大编码大小,默认 1 MiB
  staticModels:
    - id: gpt-5.6-sol
      name: GPT-5.6-Sol
      contextWindow: 272000
      maxTokens: 128000
      input: [text, image]
    - id: gpt-5.6-terra
      name: GPT-5.6-Terra
      contextWindow: 272000
      maxTokens: 128000
      input: [text, image]
    - id: gpt-5.6-luna
      name: GPT-5.6-Luna
      contextWindow: 272000
      maxTokens: 128000
      input: [text, image]
```

`input` 只允许 `text` 和 `image`;未声明时默认为 `[text]`。当前建议将
`gpt-5.6-sol`、`gpt-5.6-terra` 和 `gpt-5.6-luna` 声明为 `[text, image]`,该字段只是对 Codex 端点能力的声明,
最终仍以服务端是否接受图片请求为准。设置段热更新,无需重启。

选用 codex 作为默认模型(settings.yaml):

```yaml
agent-default-model:
  provider: codex
  model: gpt-5.6-sol
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

## 错误可观测性与安全

插件统一提取 HTTP、SSE `error`、`response.failed`、JSON 字符串和传输异常中的结构化字段。错误会按 `AUTH`、`RATE_LIMIT`、`QUOTA`、`CONTEXT_WINDOW_EXCEEDED`、`INVALID_REQUEST`、`SERVER`、`TRANSPORT`、`TIMEOUT`、`STREAM_CLOSED` 或 `PROVIDER` 分类，并保留有限的上游摘要。

示例（具体 message 会按实际字段裁剪）：

```text
Codex provider error; provider=codex; status=400; code=context_length_exceeded; message=Context window exceeded; requestId=req_xxx; diagnostics={"model":"gpt-5.6-sol","requestBytes":1234567}
```

请求诊断只包含模型、字节数、输入/消息/工具数量、工具输出长度、图片数量、reasoning 和上下文窗口等统计，不包含完整请求体。raw 摘要最多 4000 字符，并会清理 Authorization、Bearer/OAuth token、Cookie、JWT、prompt、messages、工具结果和图片数据。插件不会把完整响应 body 写入日志或 session。

## 测试

```powershell
npm test                              # 无凭证单元测试
npm run test:smoke                    # 文本对话(默认模型 gpt-5.6-sol)
npm run test:smoke -- gpt-5.5         # 指定模型
npm run test:smoke -- gpt-5.6-sol --tools   # 额外验证工具调用路径
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
| HTTP 429 | 显示 `RATE_LIMIT` 与上游摘要,由 Harness 外层策略处理限流;若明确额度耗尽则显示 `QUOTA` |
| HTTP 400 上下文超限 | 显示 `CONTEXT_WINDOW_EXCEEDED`、上游 code/message、request id 与安全 diagnostics,不会误报为普通 `provider error` |
| `INVALID_REQUEST:System messages are not allowed` | 系统提示已自动改走 `instructions` 字段,不应出现;如出现请升级插件 |
| 其他 HTTP/SSE 上游错误 | 错误中保留 provider、status、code/type、message/detail、request id 与最多 4000 字符的脱敏 raw 摘要 |
| `INVALID_REQUEST:Unsupported parameter` | 订阅后端拒绝 `max_output_tokens`/`temperature`/`stop`,适配器已自动剥离;如仍出现请升级插件 |
| 模型列表为空 | 实时发现失败且本地无 models_cache.json 时使用内置静态列表 |

## 注意事项

- 本插件会读取并(在刷新时)改写 `~/.codex/auth.json`,与 codex CLI 行为一致;如不希望
  写回,设置 `writeBack: false`(届时过期令牌只在内存中刷新,重启 dsh 后重新刷新)。
- 图片输入开放给配置为 `input: [text, image]` 的 `gpt-5.6-sol`、`gpt-5.6-terra` 和
  `gpt-5.6-luna`;图片通过
  DSH 可选附件服务读取并转换为 Responses API 的 `input_image`。没有附件服务、
  图片超出限制、或 system/assistant 历史消息包含图片时,适配器会以
  `UNSUPPORTED_CONTENT` 明确拒绝,不会静默丢图。
- 服务端可能仍拒绝图片参数;此时请移除该模型的 `image` 能力并开启新会话,因为
  原图片会保留在历史 session log 中。历史图片超出单次预算时,适配器只在当前请求
  中优先省略较早图片,不修改原始会话记录。
- 订阅额度由 OpenAI 按账号计量,与 codex CLI 共用同一配额。
