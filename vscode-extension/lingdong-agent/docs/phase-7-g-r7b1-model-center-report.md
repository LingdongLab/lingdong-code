# 阶段 G-R7b-1：模型中心与 Provider HTTP 基础

## 一、本轮范围

G-R7b 规格同时要求模型中心 Webview、Provider HTTP 层、连接测试、能力检测、
自定义 Provider、Poe Provider、目录同步、积分展示与真实抓包验收。按你的选择拆成两轮，
本轮交付其中**不依赖 Poe 凭据**的公共设施：

- HTTP 层、错误映射与有限退避
- 固定最小请求的连接测试、流式测试、无副作用能力检测
- 模型中心 Webview（独立面板 + 独立消息协议）
- 自定义 OpenAI-compatible Provider 录入与三步验证
- 模型增删启停改名、删除引用检查
- Composer 展示门槛与模式限制收紧

**明确留给 G-R7b-2**：Poe Provider 本体、`/v1/models` 目录同步与 12 小时缓存、
Poe 积分（`/usage/current_balance`）与 Poe 专属文案、**真实网络抓包验收**，
以及规格第十二部分的收口报告 `phase-7-g-r7-model-center-privacy-report.md`。

这么切的理由是本轮全部可以用本地 OpenAI-compatible 服务（Ollama、llama.cpp、vLLM
或一个测试网关）完成人工验收，不烧任何付费额度；而这些设施正是 Poe 要复用的部分，
b-2 只剩 Poe 特有的目录与积分。

## 二、两个先决约束的处理

### 模型 ID 命名空间

改动前 `grok-config-writer` 把同一个 `model.id` 同时当 TOML 表键和发给 API 的模型名。
两个服务商都提供 `DeepSeek-R1` 时，`findModel(modelId)` 与 `[models] default` 就会歧义。

现在三处分离：

- `ProviderModelConfig` 增 `remoteModelId?: string`，本地 `id` 仍是注册表唯一键
- 新增模型统一取 `id = "<providerId>:<remoteId>"`（`localModelId()`）
- `ResolvedModelEntry` 增 `apiModelId`，表键用本地 id（`tableKey` 会给含 `:` 的键加引号），
  `model =` 用 `apiModelIdOf(model)`，即 `remoteModelId ?? id`

**既有 `deepseek-v4-flash` 一个字段都没改**：不写 `remoteModelId`，`apiModelIdOf` 回落到本地
id，生成的 `[model.deepseek-v4-flash]` 与改动前逐字一致，因此无迁移、无回归。
`tests/model-id-namespace.test.ts` 用一条断言把这个「逐字一致」钉住。

`messages.ts` 的 `selectModel` 校验相应放宽到允许 `:`、长度上限 128；
路径、空白与中间换行仍然拒绝。

### base_url 约定含 `/v1`

Grok 的自定义模型文档全部以 `https://host/v1` 为 `base_url`，只追加末段路径。
宿主 HTTP 客户端用同一约定（`{baseUrl}/models`、`{baseUrl}/chat/completions`、
`{baseUrl}/responses`），所以一次校验的地址同时服务测试请求与 Grok 运行时，
不会出现「设置页测得通、真跑连不上」。现有 DeepSeek 条目是 `https://api.deepseek.com`
（无 `/v1`，DeepSeek 两种都接受），保持不动。

## 三、Provider HTTP 层

三个新文件，全部宿主侧。**Webview 永远不发 HTTP。**

### `src/models/providers/provider-http-client.ts`

安全约束落在 API 形状上，而不是靠调用方自觉：`send()` 只接受
`{ provider, path, ... }`，`path` 是固定字面量联合
`"/models" | "/chat/completions" | "/responses"`，URL 由 `provider.baseUrl` 拼出。
**签名里没有「任意 URL」这个入口**，设置页结构上传不进来。

- 传输层注入（`HttpTransport`），默认实现基于 Node 20 全局 `fetch`。注入是为了可测：
  仓库此前没有任何 `fetch` 用法，也没有 HTTP mock 先例
- `redirect: "manual"`：同源最多跟随两跳，跨域跳转直接失败并独立成
  `cross-origin-redirect`——自动跟随会把 Authorization 带到别的主机上
- `AbortController` 同时承载超时与外部取消，两者区分成不同的 `TransportFailureKind`
- 按字节流式累计，超过 `maxBytes` 立即 `reader.cancel()`。目录类 8 MiB，测试与探测类 256 KiB
- 日志只记 method、host、path、结果与耗时，整行过 `redact()`；
  **不记请求正文，不记 Authorization**

### `src/models/providers/provider-error-mapper.ts`

`ProviderErrorCode` 全量落地，状态码映射与服务商公开错误表一致：400 协议不兼容、
401 Key 无效、402 余额不足、403 无权限、404 模型不存在、408 超时、413 上下文超限、
429 限流、500 / 502 / 503 / 529 服务不可用。同一张表对 DeepSeek 与自定义网关同样成立，
所以放在公共层而不是某个 Provider 目录里。

有限退避写死在 `withLimitedRetry`：只对 429 与 5xx 重试，**最多两次**，
基准 250ms、1000ms 各加 25% jitter，`Retry-After` 与 `x-ratelimit-reset-requests`
被尊重但夹在 10 秒上限内。重试只重发**完全相同**的请求——注释与测试都写明
不换模型、不换 Provider、不回退 xAI，且只允许发生在任何工具副作用之前。

展示文案统一是「Provider · 模型：原因 + 可恢复操作」。服务商自己的 `error.message`
会被脱敏并截到 200 字符后附上；Key、Header、完整请求与完整响应在类型里就没有位置。

### `src/models/providers/provider-test-service.ts`

基础连接测试用**固定最小请求**，不携带项目代码、会话、文件、选区、Context、Plan、
Timeline 或终端输出：

- `chat_completions`：`{ model, messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 16, stream: false }`
- `responses`：`{ model, input: "Reply with exactly: OK", max_output_tokens: 16, stream: false }`

流式测试同上加 `stream: true`，断言至少收到一个 `data:` 事件。
结果只回设置页，**不进聊天记录**。

三步（连接 → 流式 → 能力）映射到六种结论：`agent-ready`、`ask-only`、
`protocol-incompatible`、`model-not-found`、`invalid-key`、`unreachable`。
连接测试失败即短路，后两步不再发请求。

## 四、能力检测

`src/models/providers/capability-probe.ts` 只有常量、请求体构造与响应解析。
`lingdong_capability_probe` 工具要求把传入值原样回显，不接触任何真实资源；
提示词是固定常量，函数除模型名外不接受任何参数，所以「不携带上下文」是签名保证的。

判定要五条同时成立：返回工具调用、名称正确、参数是有效 JSON、**经宿主 Schema 二次校验**、
`value === "ok"`。

宿主二次校验独立成纯函数 `validateProbeArguments`，拒绝多余键、非字符串与错误取值。
这一层不能省：服务商文档明确写着 `response_format` 会被忽略、工具参数是 best-effort
传递，把安全性寄托在对端的严格模式上是不成立的。测试直接喂 `{"value":123}`、
`{"value":"ok","extra":1}` 与非 JSON，全部必须拒绝。

该模块**不 import** `node:fs`、`node:child_process` 或 `vscode`。
有一条测试读源码断言 import 清单为空，比事后人工审查可靠。

## 五、协议选择

候选只有 `responses` 与 `chat_completions`，顺序固定：先测 Responses，
失败后**由用户点「尝试兼容协议」**才测 Chat Completions。成功的协议写入该模型的
`protocol` 字段，之后固定使用。

不每次请求随机试，不在请求失败时静默切协议。设置页与模型详情显示
「当前协议：Responses」或「当前协议：Chat Completions」。

## 六、模型中心

### 宿主侧

- `src/model-settings-panel.ts`：仿 `agent-panel.ts` 的 `createWebviewPanel` +
  `createNonce()` + CSP + `asWebviewUri`，HTML 只有一个 `<div id="root">`
- `src/services/model-settings-service.ts`：承接全部编排（Provider CRUD、Key 保存、
  测试、能力检测、模型增删启停），依赖注入 `ProviderService` / `ProviderTestService` /
  `SessionRepository`
- 命令 `lingdongAgent.openModelSettings`（「灵动 Agent：打开模型设置」）在
  `extension.ts` 注册
- `esbuild.mjs` 增 `src/webview/model-settings/main.ts`，产物落
  `dist/webview/model-settings/main.{js,css}`，宿主按该路径取 URI

### 独立消息协议

`src/model-settings-messages.ts` **不复用**聊天面板的 `WebviewToHostMessage`。
设置页结构上发不出 `sendPrompt`，聊天页也发不出 `saveProviderKey`，边界靠类型而非纪律。

入站白名单校验 `parseModelSettingsMessage`：id 类 `/^[A-Za-z0-9._:+-]{1,128}$/`、
`displayName` ≤ 64、`baseUrl` ≤ 2048 后过 `validateBaseUrl`、`protocol` 必须在固定集合内、
新 Key ≤ 512。出站只给 `keyConfigured: boolean`，保存 Key 后只回 `{ configured: true }`。
**协议里没有任何一条消息能取回真实 Key**，测试逐条断言了这一点。

### Webview 侧

`src/webview/model-settings/` 九个模块 + CSS，沿用现有约定（原生 DOM + `element()` +
`replaceChildren()`，无框架）。首页每个 Provider 显示名称、数据发送域名、是否启用、
Key 是否已配置、已添加模型数、最后测试时间，以及打开管理 / 禁用 / 删除。

**不显示 API Key 的任何部分，包括前后几位。** Key 输入框是 `type="password"`、
不预填、提交后立即清空。

`model-catalog-view.ts` 本轮只做手动添加所需的可搜索列表骨架，Poe 目录同步 b-2 填。
设置界面没有一行塞进 `agent-controller.ts`、`webview/main.ts` 或 `composer.ts`。

## 七、自定义 OpenAI-compatible Provider

录入服务商名称、Base URL、API Key、Model ID、协议、可选上下文长度。
URL 校验直接复用 G-R7a 的 `validateBaseUrl`：远程强制 HTTPS、HTTP 仅放行 localhost /
127.0.0.1 / ::1 / `*.localhost`、拒绝 URL 内凭据、拒绝 Query 里的 key/token/secret、
规范化尾斜杠。保存前用 `describeDataDestination(host)` 显示目标域名并要求确认。

Provider ID 由显示名 slug 化得到，非 ASCII 名（如「我的网关」）退化为 `custom`
并按 `custom-2` 递增避让冲突。

用户可以保存「仅 Ask」模型；**测试完全失败不得保存为已启用模型**。

## 八、模型管理与删除

`ProviderModelConfig` 增 `verified?: boolean`：新模型在通过基础连接测试前为 `false`，
Composer 不展示。字段缺省视为通过，所以 G-R7a 播种的 DeepSeek 条目原样可见。

`SessionRepository.findByModelId(modelId)` 做精确匹配（`filterSessions` 的模糊文本搜索
不足以支撑删除决定）。有引用时提示「有 N 个会话正在使用此模型。删除后，这些会话需要重新
选择模型。」，给取消 / 仍然删除。

删除 Provider：删配置 + 删 SecretStorage 凭据 + 收缩非敏感索引 + `refreshRedaction` +
`writeConfig` + 重投影模型列表。**不删会话、不自动替换会话模型**；
恢复时由 G-R7a 既有的 `resolveLaunch` 显式失败路径提示模型不可用。
内置 Provider 不允许删除。

## 九、Composer 与模式

- 展示门槛收紧为：Provider 已启用 **且** Key 已配置 **且** 模型已启用 **且** `verified !== false`
- 选中仅 Ask 模型时**主动降级到 Ask 并说明原因**，而不是等用户进了 Agent 才拒绝；
  `mode-service.ts` 原有门禁保留，`modeState` 携带禁用原因
- **任务执行中拒绝切换模型**：`ModelFacade` 增 `busy()` 依赖，忙时给 notice 并保持
  选择器回显原模型，既不重启 Runtime 也不改 `config.toml`——半途换服务商会让同一轮的
  前后半段打到两个地方

切换流程完全复用 G-R7a 的编排（保存 providerId + modelId → 重写 config.toml →
安全重启 → 只注入当前 Provider Key → 重绑会话），失败保留上一次选择、不自动挑别的模型。

### 顺带修掉的一个真实缺陷

`runtime-bootstrap.ts` 的 `resolveLaunchConfig()` 原先从 `lingdongAgent.model` 设置项取
`modelId`，而 `providerId` 取自会话记录。换过 Provider 之后重连，就会拿
「新 Provider + 旧模型」去解析，必然失败——表现是切换看着成功、重连时静默报错。
现在优先用当前会话的 `modelId`，设置项只作为无会话时的初值。
`tests/model-switch-guard.test.ts` 的重启断言覆盖了这条路径。

## 十、测试

新增 **87 项**测试，分十个文件，全部**显式登记**进 `package.json` 的 `test` 脚本
（该脚本是枚举式的，漏加就不跑）：

| 文件 | 项数 | 覆盖 |
| --- | --- | --- |
| `provider-http-client.test.ts` | 7 | 超时、取消、体积上限、跨域重定向拒绝、日志不含 Authorization 与正文、URL 只能由 ProviderConfig 拼出 |
| `provider-error-mapper.test.ts` | 11 | 各状态码映射、429 退避两次后放弃、失败不换 Provider |
| `provider-test-service.test.ts` | 8 | 最小请求不含项目上下文、两种协议、协议按模型保存、流式测试、失败短路 |
| `capability-probe.test.ts` | 9 | 工具调用判定、strict 失效时宿主仍拒绝非法参数、模块 import 清单为空 |
| `model-settings-messages.test.ts` | 9 | 协议不返回真实 Key、无可取回 Key 的消息、非法 baseUrl / protocol / 超长输入被拒 |
| `model-settings-view.test.ts` | 9 | （jsdom）列表不渲染 Key、能力结果与当前协议展示、内置与自定义的删除按钮差异 |
| `custom-provider.test.ts` | 12 | HTTPS / localhost HTTP / URL 内凭据 / Query Key 的放行与拒绝、六种结论、仅 Ask 可保存 |
| `model-delete-rules.test.ts` | 8 | 按 modelId 精确找引用、删模型不删会话、删 Provider 连带删凭据、内置不可删 |
| `model-switch-guard.test.ts` | 7 | 按 Provider 分组、仅 Ask 强制 Ask、会话存 providerId + modelId、切换只注入新 Key、忙时拒绝切换 |
| `model-id-namespace.test.ts` | 7 | 表键与远端模型名分离、同名模型不冲突、DeepSeek 逐字无回归、`selectModel` 放宽后的边界 |

`tests/support/vscode-stub.ts` 补了 `window.withProgress`（此前完全没有，一调就抛）与
可交互的 `createWebviewPanel`（捕获 `html`、`postMessage`、`onDidReceiveMessage`）。
新增 `tests/support/model-settings-harness.ts`：真实落盘 + mock 传输层 + 可控会话查询。
时钟一律走既有的 `now?: () => number` 注入模式，没有引入 fake timers。

### 结果

```
npm run typecheck   通过
npm test（扩展）     581 / 581 通过
npm test（Runtime）   77 /  77 通过
npm run build       通过（dist/webview/model-settings/main.{js,css} 已产出）
```

基线 571 项（扩展 494 + Runtime 77）**一项未删、未跳过、未弱化**，
扩展侧从 494 增至 581。

## 十一、人工验收清单

本轮对应规格第二十六、二十八、二十九、三十节，需要你在真实环境跑一遍：

1. **DeepSeek 无回归**：原会话继续发送，模型中心显示「Key 已配置」但不显示 Key 内容，
   Agent / Plan / Timeline 正常
2. **自定义服务**：添加一个本地 OpenAI-compatible 服务（Ollama / llama.cpp / vLLM），
   确认 Base URL 校验、最小连接测试、流式测试、能力检测、Composer 可选
3. **能力检测两侧**：一个支持工具调用的模型进得了 Agent；一个不通过检测的只允许 Ask，
   且宿主对工具参数仍然严格
4. **失败场景**：错误 Key、不存在的模型、请求超时、限流各测一遍，确认文案正确、
   不泄漏 Key、不静默切 Provider、不无限重试

第二十七节（Poe）与第三十一节（抓包）随 G-R7b-2。

## 十二、已知限制

- **本轮无真实网络验证**：全部测试走注入的 mock 传输层。默认 `fetchTransport` 的行为
  （尤其是重定向与流式体积上限）要等 b-2 的抓包验收才算被真实链路确认过
- `findByModelId` 只查当前工作区的会话（会话本就按 `workspaceId` 隔离），
  跨工作区的引用统计不到
- `messages` 协议（Anthropic 形态）不在可测协议候选内，本轮不支持自动检测
- `model-catalog-view.ts` 只有可搜索列表骨架，没有目录数据源
- 能力检测消耗一次真实模型调用（约 128 token），重测同理

## 十三、改动文件

**新增（宿主）**

- `src/models/providers/provider-http-client.ts`
- `src/models/providers/provider-error-mapper.ts`
- `src/models/providers/provider-test-service.ts`
- `src/models/providers/capability-probe.ts`
- `src/model-settings-messages.ts`
- `src/model-settings-panel.ts`
- `src/services/model-settings-service.ts`

**新增（Webview）**

- `src/webview/model-settings/main.ts`
- `src/webview/model-settings/model-settings-view.ts`
- `src/webview/model-settings/model-settings-state.ts`
- `src/webview/model-settings/provider-list-view.ts`
- `src/webview/model-settings/provider-editor-view.ts`
- `src/webview/model-settings/provider-key-view.ts`
- `src/webview/model-settings/model-list-view.ts`
- `src/webview/model-settings/model-catalog-view.ts`
- `src/webview/model-settings/capability-result-view.ts`
- `src/webview/model-settings/model-settings.css`

**修改**

- `src/models/providers/provider-types.ts`（`remoteModelId` / `verified` /
  `localModelId` / `apiModelIdOf` / `isModelVerified`）
- `src/models/providers/grok-config-writer.ts`（`apiModelId` 与表键分离）
- `src/models/providers/provider-registry.ts`（模型增删改）
- `src/model-registry.ts`（`toModelDescriptors` 的展示门槛）
- `src/messages.ts`（`selectModel` 放宽、`openModelSettings`）
- `src/services/model-facade.ts`（忙时拒绝切换、主动降级到 Ask）
- `src/services/mode-service.ts`（禁用原因）
- `src/services/provider-service.ts`、`src/services/runtime-bootstrap.ts`（会话模型优先）
- `src/storage/session-repository.ts`（`findByModelId`）
- `src/agent-controller.ts`、`src/extension.ts`、`src/webview-message-handler.ts`
- `src/webview/composer.ts`（进入模型设置的入口）
- `package.json`（命令、测试脚本）、`esbuild.mjs`（新 entry）

**测试**

- 上表十个文件，外加 `tests/support/vscode-stub.ts` 与新增的
  `tests/support/model-settings-harness.ts`

---

阶段 G-R7b-1 到此结束。未开始阶段 H，未 Fork Code-OSS，未打包独立安装程序。
Poe Provider、目录同步、积分与网络抓包验收属 G-R7b-2。
