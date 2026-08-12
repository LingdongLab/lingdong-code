# Grok Build 网络与隐私配置审计

本文记录灵动 Agent 实际使用的 Grok Build 版本的网络相关配置，以及扩展采用的关闭方式。
所有字段名与默认值都来自本机随包文档，不是推测；无法从文档确认的通道单列一节，不写成「已关闭」。

## 一、被审计的对象

| 项目 | 值 |
| --- | --- |
| Grok Build 版本 | 0.2.118 |
| 安装位置 | `E:\LingdongCode\grok\` |
| 原 GROK_HOME | `E:\LingdongCode\grok\data` |
| 文档来源 | `E:\LingdongCode\grok\data\docs\user-guide\` |
| 审计时间 | 2026-08-06 |
| 审计方式 | 阅读随包文档与本机现有 `config.toml`；**未做抓包** |

主要参考文件：

- `05-configuration.md`（配置字段与环境变量总表）
- `11-custom-models.md`（自定义模型与凭据解析顺序）
- `14-headless-mode.md`（自动更新关闭方式）
- `24-monitoring-usage.md`（遥测与外部 OTEL）
- `02-authentication.md`、`04-slash-commands.md`（`/privacy` 的作用范围）

## 二、真实存在的字段与环境变量

下表每一行的字段名、环境变量名与默认值都能在上述文档中直接查到。
**注意默认值：`feedback` 与 `remote_fetch` 默认是开启的**，漏写就等于开着。

| 通道 | config.toml 字段 | 环境变量 | 文档默认值 | 灵动的关闭方式 |
| --- | --- | --- | --- | --- |
| 产品遥测总开关 | `[features] telemetry` | `GROK_TELEMETRY_ENABLED` | `false` | 双通道：写 `false` + 注入 `0` |
| 会话 Trace 上传 | `[telemetry] trace_upload` | `GROK_TELEMETRY_TRACE_UPLOAD` | 跟随 telemetry | 双通道：写 `false` + 注入 `0` |
| Mixpanel 产品分析 | `[telemetry] mixpanel_enabled` | `GROK_TELEMETRY_MIXPANEL_ENABLED` | 跟随 telemetry | 双通道：写 `false` + 注入 `0` |
| 外部 OpenTelemetry | `[telemetry] otel_enabled` | `GROK_EXTERNAL_OTEL` | `0` | 双通道：写 `false` + 注入 `0` |
| Feedback 系统 | `[features] feedback` | `GROK_FEEDBACK_ENABLED` | **`true`** | 双通道：写 `false` + 注入 `0` |
| 自动更新 | `[cli] auto_update` | `GROK_DISABLE_AUTOUPDATER` | **`true`** | 双通道：写 `false` + 注入 `1` |
| 远程模型目录抓取 | `[features] remote_fetch` | **无** | **`true`** | 只能写 `false`（见下） |
| 内置 web_fetch 工具 | `[toolset.web_fetch]` 相关 | `GROK_WEB_FETCH` | 启用 | **保持启用**（功能需求，见下） |
| 内置 web_search 工具 | `[models] web_search` + permission | 无 | 见第五节 | **deny WebSearch**；改由宿主 MCP |

### 联网能力（对标 Cursor，2026-08 起）

联网搜索/网页抓取是产品功能，不是遥测通道，与上表其它项性质不同：

- **宿主侧 Web Search（MCP `lingdong_web`）**：扩展打包 `dist/web-search-mcp.js`，写入
  `[mcp_servers.lingdong_web]`，由 Grok 以 stdio 拉起。command 优先 PATH 上的 `node`；
  若无则用 `Code.exe` + `ELECTRON_RUN_AS_NODE=1`（切勿直接拿扩展宿主 execPath 当 node，
  否则 MCP 会连接超时）。搜索查询发往 **DuckDuckGo / Bing**（多引擎回退），
  **不经** Poe/DeepSeek 等对话模型供应商。
- **关闭内置 backend WebSearch**：`[permission] deny = ["WebSearch"]`，且**不写**
  `[models] web_search`——第三方模型没有 `supports_backend_search`，走内置路径会鉴权失败。
- `GROK_WEB_FETCH` 不再注入 `0`：网页抓取由本机直接发起 HTTP 请求，受 Grok 的 SSRF 防护
  约束（loopback/私网/云元数据默认拒绝，`allow_local` 默认 false），工具调用仍要过扩展的
  权限矩阵。

### 为什么必须托管 config.toml

`[features] remote_fetch` **没有对应的环境变量**（`05-configuration.md` L69 只给出 TOML 形式，
L726-753 的环境变量总表里也没有它）。此外文档明确写着某些键 TOML 优先于 env
——`05-configuration.md` L187 关于 `allow_local` 的解析顺序是「TOML > env > default」。

结论：单靠注入环境变量无法满足「强制关闭 remote_fetch」，扩展必须持有 config.toml 的写入权。
这直接决定了本轮采用托管 GROK_HOME 的方案。

### 为什么必须剥离 XAI_API_KEY

`11-custom-models.md` L96-101 给出的凭据解析顺序是：

1. 模型配置里的 `api_key`
2. `env_key` 指名的环境变量
3. `grok login` 得到的会话 token
4. **`XAI_API_KEY`（全局兜底，也接受 `GROK_CODE_XAI_API_KEY`）**

第 4 条意味着：只要宿主进程环境里存在 `XAI_API_KEY`，Grok 在其它凭据缺失时就会静默用它发请求。
不把它从子进程环境里剥掉，「不自动回退 xAI」只是纸面承诺。

同一段解析顺序也说明 `api_key` 与 `env_key` 是二选一。我们只写 `env_key`，
因此真实凭据在结构上永不落盘——`renderGrokConfig` 的入参类型里根本没有 key 字段。

## 三、灵动采用的具体做法

### 托管 GROK_HOME

- 目录：`<globalStorage>/grok-home/`
- 首次播种从原 GROK_HOME 复制：`vendor/`（自带 ripgrep override）、`agent_id`、`.metadata_version`
- **不复制**：`config.toml`（整份生成）、`installer-profile/`（含约 140MB 安装包）、
  `logs/`、`sessions/`、`memtrace/`、`relocations/`
- 播种标记 `.lingdong-managed.json` 记下来源、时间与版本，据此只播种一次
- 设置 `lingdongAgent.managedGrokHome`（默认开启）可关闭；显式 `lingdongAgent.grokHome` 优先级最高
- 原 GROK_HOME 全程只读，不做任何写入

### 生成的 config.toml

由 `src/models/providers/grok-config-writer.ts` 的纯函数 `renderGrokConfig` 产出，包含：

```toml
[models]
default = "<当前会话模型>"
# 不写 web_search —— 内置 backend 搜索已用 permission deny 关掉

[features]
telemetry = false
feedback = false
remote_fetch = false

[telemetry]
mixpanel_enabled = false
trace_upload = false
otel_enabled = false

[cli]
auto_update = false

[marketplace]
default_skills_installs_purged = true

[mcp_servers.lingdong_web]
command = "<node>"
args = ["<extension>/dist/web-search-mcp.js"]
enabled = true

[permission]
deny = ["WebSearch"]
allow = ["MCPTool(lingdong_web__*)"]

[model.<id>]
model = "..."
base_url = "..."
name = "..."
env_key = "LINGDONG_KEY_<PROVIDER>"
api_backend = "responses" | "chat_completions" | "messages"
context_window = ...
```

不写 `supports_backend_search`，永不写 `api_key`。

### 子进程环境

由 `src/privacy/runtime-env.ts` 的 `buildChildEnv` 整份构造，而不是 spread `process.env`：

- 按具名 deny-list 剥离 `XAI_API_KEY`、`GROK_CODE_XAI_API_KEY`、`DEEPSEEK_API_KEY`、
  `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`GEMINI_API_KEY`、
  `GOOGLE_API_KEY`、`OPENROUTER_API_KEY`、`TOGETHER_API_KEY`、`POE_API_KEY` 等
- 用具名列表而不是 `/_KEY$/` 之类的正则：Grok 的 bash 工具会跑用户脚本，
  一刀切会连带弄坏与模型无关的工具链
- 清掉所有 `LINGDONG_KEY_*`，再注入当前会话 Provider 的那**一个**
- 强制写入第二节表格里的隐私环境变量，覆盖父进程中已开启的值

## 四、凭据存放位置

| 位置 | 是否含凭据 |
| --- | --- |
| VS Code SecretStorage | 是，唯一存放处 |
| `providers.json` | 否，只有 `secretId` |
| `config.toml` | 否，只有 `env_key` 变量名 |
| `session.json` / `transcript.json` / `turns.json` / `plans.json` | 否，落盘前统一脱敏 |
| Output Channel / Timeline / 报告 | 否，统一脱敏 |
| 子进程环境 | 是，仅当前 Provider 的一个变量 |

`ProviderSecretStore` 刻意不提供 `getAllKeys`；`hasKey` 查的是只含 providerId 的非敏感索引，
回答「是否已配置」不会把明文读进内存。

## 五、无法验证的通道

以下几项**不能**标记为已关闭，如实记录状态与原因。

### 联网搜索（宿主 MCP）

内置 `[models] web_search` / backend WebSearch **已关闭**（permission deny）。
实际搜索由 MCP `lingdong_web` → DuckDuckGo 完成。隐私含义变了：搜索查询会发往
DuckDuckGo，而不再发往对话模型供应商；网页抓取仍走 Grok `web_fetch`。

状态：**已启用（宿主侧 DuckDuckGo；真机需确认 MCP 握手与工具调用成功）**

### 远程 fleet / 管理配置策略

`24-monitoring-usage.md` L128 提到「若没有任何 fleet policy 可用——`[features] remote_fetch = false`」，
说明托管配置同步是另一条独立通道（文档写作 `managed_config`）。我们已把 `remote_fetch` 写成 `false`，
但没有独立验证 `managed_config` 的实际行为。

状态：**配置层面已关闭 remote_fetch，实际请求待抓包确认**

### 无自定义模型时的默认端点

在没有自定义模型、也没有登录的情况下，Grok 会走自己的默认端点
（历史日志里出现过 `auth.x.ai`；文档提到过 `cli-chat-proxy.grok.com`）。
本轮为每个启用模型都写了显式的 `base_url` 与 `env_key`，正常路径不应触发默认端点，
但**没有抓包验证异常路径**（例如凭据无效时的重试行为）。

状态：**待抓包确认**

### `/privacy` 斜杠命令

`04-slash-commands.md` L422 明确说 `/privacy` 不影响 `[features] telemetry`、`trace_upload`
与外部 OTEL 设置，并且团队账号下只有管理员能改。它与我们控制的字段互不覆盖，
我们不依赖它，也不修改它。

状态：**不在本轮控制范围内**

## 六、验收结论

代码与配置层面的关闭动作已完成，且有自动测试守护（覆盖父进程遥测值被覆盖、
`XAI_API_KEY` 被剥离、凭据注入范围受控、config.toml 各开关为 false、产物不含凭据等）。

> **边界更新（对标 Cursor 免重连切模）**：子进程环境自「只注入当前 Provider 一把密钥」
> 放宽为「注入所有**已启用且配置了密钥**的 Provider 密钥」（`LINGDONG_KEY_*` 槽位）。
> 这是 `session/set_model` 跨 Provider 免重连的前提。宿主环境里的其他凭据
> （`XAI_API_KEY`、`OPENAI_API_KEY` 等）仍全部剥离；禁用某个 Provider 后，
> 下次启动子进程不再注入它的密钥。凭据只会发给用户自己启用过的服务商。

**网络隐私仍待抓包验收。** 建议用 TCPView、资源监视器或本地代理观察 `grok.exe`：
普通任务期间应只访问已启用 Provider 的域名与必要的本地连接。
若仍看到未授权的 xAI、遥测、Mixpanel 或更新服务连接，请记录域名与触发条件，
并且本阶段不得把网络隐私标记为验收通过。

本文不声称「不会向其他服务器上传」。
