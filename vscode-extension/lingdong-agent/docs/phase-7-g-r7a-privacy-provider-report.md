# 阶段 G-R7a：隐私边界与 Provider 基础

## 一、本轮范围与拆分理由

原 G-R7 规格同时要求 ProviderRegistry、SecretStorage、统一脱敏、模型中心 Webview、
HTTP 客户端、TOML 生成、环境隔离、会话级模型选择、隐私命令、URL 校验与约 30 项测试，
体量明显超出前几轮。按你的选择拆成两轮：

**G-R7a（本轮）**：规格第四、五（仅 DeepSeek）、六、七、十三（最小）、十四、十五、十六、
十七、十八、十九、二十节。

**G-R7b（下一轮）**：Poe Provider（第九至十二节）、模型中心 Webview（第八节）、
`/v1/models` 目录同步、`lingdong_capability_probe` 能力检测。
规格原定的 `phase-7-g-r7-model-center-privacy-report.md` 由 G-R7b 收口。

G-R6 的三项人工验收你已确认通过，无遗留缺陷带入本轮。

## 二、审计结论（决定了整体设计）

完整审计见 [docs/privacy/grok-network-audit.md](privacy/grok-network-audit.md)。三条硬约束：

1. **`[features] remote_fetch` 没有环境变量**（`05-configuration.md` L69 只给 TOML 形式），
   且文档明确写着部分键 TOML 优先于 env。单靠注入环境变量无法关闭它，
   **必须由扩展持有 config.toml 的写入权**。
2. **`api_key` 与 `env_key` 二选一**（`11-custom-models.md` L96-101）。只写 `env_key`，
   真实凭据在结构上永不落盘——`renderGrokConfig` 的入参类型里没有 key 字段。
3. **凭据兜底会退到 `XAI_API_KEY`**（同上第 4 条）。不把它从子进程环境剥掉，
   「不自动回退 xAI」只是纸面承诺。

好消息：`agent-runtime` 早已支持 `options.env` 覆盖，只是 `RuntimeBootstrap` 之前没传。
所以子进程环境完全由扩展侧构造，Runtime 包只需要一处 additive 改动。

## 三、托管 GROK_HOME

`src/privacy/managed-grok-home.ts`：

- 目录 `<globalStorage>/grok-home/`
- 播种复制：`vendor/`（自带 ripgrep override）、`agent_id`、`.metadata_version`
- 不复制：`config.toml`（整份生成）、`installer-profile/`（约 140MB 安装包）、
  `logs/`、`sessions/`、`memtrace/`、`relocations/`
- `.lingdong-managed.json` 记 `seededFrom` / `seededAt` / `grokVersion`，据此只播种一次
- 新设置 `lingdongAgent.managedGrokHome`（默认 `true`）作为退路；
  显式 `lingdongAgent.grokHome` 优先级最高
- 原 GROK_HOME 全程只读

`resolveGrokHome()` 语义未变，仍返回**探测到的原始**目录，现在只作为播种源；
真正交给子进程的是托管目录。

两个已知副作用，写在审计文档里而不是藏着：

- grok 侧 `sessions/` 不迁移，旧 `grokSessionId` 的 `session/load` 会失败。
  现有链路已覆盖这一点（`agent-controller.chain.test.ts` 的
  「底层会话恢复失败时保留本地记录并新建会话」），我们自己的 transcript、Plan、
  Timeline、Changes 都不受影响。
- 可执行文件不再位于 `$GROK_HOME/bin/grok`，grok 视其为非托管安装。
  auto_update 本轮双通道关闭，无实际影响。

## 四、ProviderRegistry 架构

新增 `src/models/providers/`：

| 文件 | 职责 |
| --- | --- |
| `provider-types.ts` | `ProviderProtocol` / `ProviderConfig` / `ProviderModelConfig` / `ModelCapabilities`；`envKeyName` 与 `secretIdFor` 派生；DeepSeek 播种数据 |
| `provider-registry.ts` | Provider 与模型的增删改查、启用禁用、按 Provider 查模型；持久化到 `<globalStorage>/agent-providers/providers.json` |
| `provider-validator.ts` | Base URL 校验（纯函数） |
| `provider-secret-store.ts` | 包裹 `context.secrets`，无 `getAllKeys` |
| `runtime-model-profile.ts` | 一次启动的真实画像，隐私状态的唯一数据源 |
| `grok-config-writer.ts` | 生成 config.toml 的纯函数 |

`src/services/provider-service.ts` 是编排层，把上面这些与托管目录、子进程环境串起来。

关键约束落在类型层而不是纪律层：

- `ProviderConfig` **没有** key 字段，只有 `secretId`
- 从文件读回时忽略写入的 `secretId`，始终按 `providerId` 重新派生，
  避免被改成别的 Provider 的槽位
- 模型能力缺省 `agentCompatible: false`——没检测过就不该默认放行工具调用
- 不预置启用 xAI Provider
- `findModel` / `get` 找不到就返回 `undefined`，不返回替代品

新增 `StorageKind` `"providers"`，`SCHEMA_VERSION` 2 → 3。

## 五、SecretStorage 实现

`ProviderSecretStore` 提供 `saveKey` / `getKey` / `hasKey` / `deleteKey` / `reconcile` /
`secretLiterals`，命名空间 `lingdongAgent.providerKey.<providerId>`。

- **刻意不提供 `getAllKeys`**：没有批量导出入口，泄漏面小一截（有测试断言这个方法不存在）
- `hasKey` 查 `globalState` 里只含 providerId 的非敏感索引，
  回答「是否已配置」不把明文读进内存（有测试断言此时零次读取）
- `reconcile` 在启动时校准索引：外部清空过 SecretStorage 时，
  界面不会谎报「已配置」而注入时拿不到凭据
- 空字符串等于删除，不会存下一个空凭据
- Webview 协议里没有任何能取回 Key 的消息类型

## 六、DeepSeek 配置迁移

- 首次加载 Provider 注册表为空时，用本机现有 config.toml 的既有事实播种一个
  `deepseek` Provider（`https://api.deepseek.com`、`responses`、上下文 1,000,000）
- 新命令**灵动 Agent：配置模型服务商密钥**（`lingdongAgent.configureProviderKey`）：
  QuickPick 选 Provider → `InputBox`（`password: true`）录入 → 写 SecretStorage。
  用 VS Code 原生 UI，不用浏览器 prompt
- 检测到环境变量 `DEEPSEEK_API_KEY` 时，首次启动提示一键导入；
  导入后子进程不再继承它（已被 deny-list 剥离）
- **扩展无权删除系统环境变量**，导入后会提示用户可自行清理 OS 变量。如实说明，不含糊
- 未配置 Key 时给可恢复错误 + 「配置密钥…」/「打开设置」，不静默降级

## 七、Runtime 凭据注入

`src/privacy/runtime-env.ts` 的 `buildChildEnv` 整份构造子进程环境：

- 按具名 deny-list 剥离 `XAI_API_KEY`、`GROK_CODE_XAI_API_KEY`、`DEEPSEEK_API_KEY`、
  `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`GEMINI_API_KEY`、
  `GOOGLE_API_KEY`、`OPENROUTER_API_KEY`、`TOGETHER_API_KEY`、`POE_API_KEY` 等
- 用具名列表而非正则：Grok 的 bash 工具会跑用户脚本，
  一刀切会连带弄坏与模型无关的工具链
- 清掉所有 `LINGDONG_KEY_*` 再注入当前会话 Provider 的那**一个**，
  切换 Provider 后旧槽位一定消失
- 强制写入 `GROK_TELEMETRY_ENABLED=0`、`GROK_TELEMETRY_TRACE_UPLOAD=0`、
  `GROK_TELEMETRY_MIXPANEL_ENABLED=0`、`GROK_EXTERNAL_OTEL=0`、
  `GROK_FEEDBACK_ENABLED=0`、`GROK_DISABLE_AUTOUPDATER=1`、`GROK_WEB_FETCH=0`，
  覆盖父进程里已开启的值

`RuntimeBootstrap.start()` 先 `resolveLaunch(providerId, modelId)`，
解析出「一个 Provider + 一个模型 + 一个凭据」，再准备托管目录、生成 config.toml、
构造环境，最后启动。启动成功后记录 `RuntimeModelProfile`。

Runtime 包唯一改动：`RuntimeInitializeOptions` 增 `redactValues?: readonly string[]`，
透传给 `SafeLogger`。凭据搬进 SecretStorage 后不再出现在 `process.env` 里，
`logger.ts` 原本靠读环境变量拿字面量的路径已经失效，
不补这一处会在 `acp-raw.log` 重新开始泄漏。

## 八、统一脱敏

`src/privacy/secret-redactor.ts` 是宿主侧唯一实现。Runtime 侧 `logger.ts`
与 `context-model.ts` 各自的职责保持不变，不造第三套。

覆盖的模式：`Authorization: Bearer`、`x-api-key`、`Cookie` / `Set-Cookie`、
`api_key` / `apikey` / `access_token` / `refresh_token` / `token` / `secret` /
`password` / `credential`（含 JSON 里 `"api_key":"…"` 的引号形态）、
URL Query 里的 `key` / `token` / `api_key`、少量高置信度令牌形态。
**不只认 `sk-` 前缀**——DeepSeek、Poe 与自建网关的 Key 形态各不相同。

最可靠的一条是字面量注册：从 SecretStore 载入当前全部已配置凭据做整串替换，
Key 变更时刷新。少于 8 位的值不登记，避免把正常文本打成马赛克。

落点：

| 落点 | 实现方式 |
| --- | --- |
| Output Channel | `AgentController` 的 `log` 统一过 `redact` |
| Timeline `detail` | `timeline-service.ts` 的 `trim` 先脱敏再截断 |
| transcript 落盘 | `sanitizeEntry` 串联 Runtime 与宿主两层脱敏 |
| Timeline 序列化 | 既有 `serializeTurnPresentation({ redact })` 入口，现已含宿主层 |
| 结构化数据 | `redactUnknown` 按键名整值替换，结构不变 |

## 九、会话级 Provider 选择

- `SessionRecord` 增 `providerId?: string`
- `SCHEMA_VERSION` 2 → 3，六种 kind 都补齐了 `1:` 与 `2:` 迁移。
  `session` 的 v2→v3 是真实迁移：`modelId === "deepseek-v4-flash"` 时补 `providerId: "deepseek"`，
  其余 modelId **留空**——猜一个 providerId 等于替用户改数据流向
- 新建会话与绑定底层会话时写入 `providerId`；切换模型时 `providerId` 一起更新
- 恢复时 Provider 已删除或 Key 不存在：明确提示
  「此会话原来使用 X · Y，但对应凭据已不存在，请重新配置」，**不替换模型**
- 切换 Provider 的编排：保存选择 → 重写 config.toml → 安全重启 Runtime →
  注入新 Key → 重绑会话。Plan / Timeline / Changes 都在我们自己的 store 里，不受重启影响

## 十、禁止静默回退

- `ProviderService.resolveLaunch` 的四种失败（Provider 不存在 / 已禁用 / 模型不存在 /
  凭据缺失）各有明确文案，一律不换 Provider 或模型
- `RuntimeBootstrap` 失败时弹出「配置密钥…」/「打开设置」两个出口，
  刻意**不提供**「换一个模型继续」
- `ModelFacade.select` 失败时文案从「已回退到 X」改为「仍在使用 X」：
  它回到的是用户上一次自己选的模型，不是系统替他挑的
- 本轮不实现备用模型

## 十一、最小 Composer 改动

- `ModelDescriptor` 增 `providerId` 与 `agentCompatible`
- 模型清单的权威来源改为 ProviderRegistry，`toModelDescriptors` 做投影，
  `ModelRegistry.replace` 整体替换
- Composer 模型浮层按 Provider 分组（本轮只有一组），
  `agentCompatible === false` 的模型带「仅 Ask」徽标
- `ModeService.set` 对这类模型拒绝切到 Ask 以外的模式，
  提示「尚未通过工具调用测试，目前仅支持 Ask 模式」
- 完整模型中心 UI 属于 G-R7b

## 十二、隐私状态

新增命令**灵动 Agent：查看隐私状态**（`lingdongAgent.showPrivacyStatus`），
通过 `TextDocumentContentProvider`（scheme `lingdong-privacy:`）以只读 Markdown 打开。

`renderPrivacyStatus` 是纯函数，数据全部来自 `RuntimeModelProfile` 与实际生成的配置：

- 未连接时如实说「尚未连接」，**不把设置里的期望值当成运行状态**
- 通道开着就显示「已开启」；托管目录关闭时明确说明这些开关无法保证
- `API Key` 一栏只显示「已配置」/「未配置」，不显示真实 Key，也不显示前后几位
- 逐条列出强制写入的环境变量与被剥离的凭据变量名（只有名字，没有值）
- 结尾明确标注网络行为仍待抓包验收

## 十三、Base URL 安全校验

`validateBaseUrl` 纯函数，返回规范化地址、展示用域名与是否本地：

| 情形 | 结果 |
| --- | --- |
| 远程 `http://` | 拒绝（`insecure-remote`） |
| `localhost` / `127.0.0.0/8` / `::1` / `*.localhost` 的 `http://` | 放行 |
| URL 内含用户名或密码 | 拒绝（`embedded-credentials`） |
| Query 里有 `key` / `api_key` / `token` / `secret` 等 | 拒绝（`secret-in-query`） |
| 非 http/https 协议 | 拒绝（`unsupported-scheme`） |
| 尾部斜杠 | 规范化去掉 |

`describeDataDestination(host)` 生成保存前的数据流向提示。

## 十四、新增测试数量

新增 **77 项**（扩展 72 + Runtime 5），覆盖规格第二十一节除 Poe / 能力检测（第 14-20 项，
属 G-R7b）以外的全部条目。

| 文件 | 项数 | 覆盖 |
| --- | --- | --- |
| `tests/provider-registry.test.ts` | 6 | 增删改查、启用禁用、落盘不含 Key、无自动回退、无预置 xAI、env_key 派生 |
| `tests/provider-secret-store.test.ts` | 7 | 写入 SecretStorage、`hasKey` 不读明文、无 `getAllKeys`、删除、索引校准 |
| `tests/provider-validator.test.ts` | 7 | 远程 HTTP 拒绝、localhost 放行、URL 内凭据、Query 放 Key、尾斜杠 |
| `tests/grok-config-writer.test.ts` | 7 | 七个开关全 false、不含 Key、不写 web_search、env_key 派生、禁用项不写入 |
| `tests/runtime-env.test.ts` | 7 | 父进程遥测值被覆盖、`XAI_API_KEY` 剥离、只注入一个、切换后旧变量消失 |
| `tests/secret-redactor.test.ts` | 10 | Bearer / Cookie / Query / 非 `sk-` 前缀 / 已注册字面量；三处落点各一项 |
| `tests/managed-grok-home.test.ts` | 6 | 只播种一次、排除清单、标记文件、无源目录、config 落点 |
| `tests/session-provider-migration.test.ts` | 7 | v2→v3 补 providerId、不猜归属、跨级迁移、保存与恢复 |
| `tests/privacy-status.test.ts` | 7 | 状态来自 Profile、逐条通道、不粉饰、不显示 Key、未连接、待抓包标注 |
| `tests/provider-runtime-wiring.test.ts` | 8 | 端到端：环境隔离、config 生成、凭据缺失、会话 providerId、日志脱敏、隐私状态 |
| `packages/agent-runtime/tests/logger.test.ts` | +2 | 登记字面量整串替换、可清空且过短不登记 |

`tests/support/vscode-stub.ts` 补了 `secrets`（`get`/`store`/`delete`/`onDidChange`）、
`globalState` Memento、`registerTextDocumentContentProvider` 记录、
`languages.setTextDocumentLanguage`。`controller-harness.ts` 增 `providerKey` 选项
（传 `null` 表示刻意不配置，用于验证凭据缺失路径）。

## 十五、全部测试结果

```
扩展：494 / 494 通过（原 422 + 新增 72）
Runtime：77 / 77 通过（原 75 + 新增 2）
合计：571 项通过
npm run typecheck（两个包）：通过
npm run build（两个包）：通过
```

原有 497 项全部保留，没有删除、跳过或弱化。

一项既有测试按新事实更新了断言：`timeline-persistence.test.ts` 的
「schema 升到 v2 时五种 kind 全部登记了迁移」改为「schema 每一级都为全部 kind 登记了迁移」，
断言 `SCHEMA_VERSION === 3` 并逐级检查六种 kind。这是版本推进的必然结果，不是弱化——
新断言比原来更严（检查每一级而不只是第一级）。

## 十六、人工验收

本轮对应规格第二十二、二十五、二十六、二十七节；第二十三、二十四节（Poe、能力检测）
随 G-R7b 验收。以下四项需要你在 Extension Development Host 中确认：

### 1. DeepSeek 迁移（第二十二节）

1. 启动扩展。若系统里有 `DEEPSEEK_API_KEY`，应弹出导入提示；点「导入」
2. 或执行**灵动 Agent：配置模型服务商密钥**手动录入
3. 正常发送一轮任务，确认原有会话仍可用
4. 检查 `<globalStorage>/agent-providers/providers.json` 与
   `<globalStorage>/grok-home/config.toml`：都不该出现 Key
5. 查看 Output Channel「灵动 Agent」：不该出现 Key

### 2. 失败处理（第二十五节）

1. 执行配置密钥命令，故意填一个错误的 Key
2. 发送任务，确认错误信息里明确写出 Provider 与模型
3. 确认**没有**自动切到别的模型或 Provider
4. 确认日志里不含凭据
5. 删除凭据后再发送，确认提示「凭据已不存在，请重新配置」而不是静默降级

### 3. 重启恢复（第二十六节）

1. 完成一轮任务后重启 Extension Development Host
2. 确认 Provider 与已添加模型恢复
3. 确认会话的模型选择恢复
4. 确认 Key 从 SecretStorage 读出，Runtime 正常连接
5. 注意：托管 GROK_HOME 不迁移 grok 侧 `sessions/`，
   首次切换后旧 `grokSessionId` 的 `session/load` 会失败并自动新建底层会话，
   本地 transcript / Plan / Timeline / Changes 不受影响

### 4. 网络检查（第二十七节）

1. 用 TCPView、资源监视器或本地代理观察 `grok.exe`
2. 普通任务期间应只访问 `api.deepseek.com` 与必要的本地连接
3. 执行**灵动 Agent：查看隐私状态**核对各通道
4. 若仍看到未授权的 xAI、遥测、Mixpanel 或更新服务连接，
   记录域名与触发条件

**当前状态：代码配置已完成，网络隐私仍待抓包验收。**

本报告不声称「不会向其他服务器上传」。

## 十七、实际发现的网络目标

未执行抓包，因此这一节只能记录**文档层面**确认存在的目标，以及历史日志里出现过的主机：

| 目标 | 来源 | 本轮处置 |
| --- | --- | --- |
| `api.deepseek.com` | 用户配置的模型 API | 保留，这是用户主动选择的 Provider |
| `auth.x.ai` | 历史日志里唯一实际出现过的 xAI 主机 | `XAI_API_KEY` 已剥离；未验证是否仍有连接 |
| `cli-chat-proxy.grok.com` | 文档提到的默认端点 | 每个模型都写了显式 `base_url`；未验证异常路径 |
| 遥测 / Mixpanel / OTEL 端点 | 文档 | 双通道关闭；未抓包验证 |
| 模型目录抓取端点 | `[features] remote_fetch` | config.toml 写 `false`；未抓包验证 |
| 自动更新端点 | `[cli] auto_update` | 双通道关闭；未抓包验证 |

## 十八、已知限制

1. **网络隐私未抓包验收。** 全部结论止于配置与代码层面。
2. **`[models] web_search` 没有文档化的关闭开关。** 我们不写该字段、不设
   `supports_backend_search`，状态记为「未暴露（待抓包确认）」，而不是「已关闭」。
3. **扩展无权删除 OS 环境变量。** 导入 `DEEPSEEK_API_KEY` 后子进程不再继承它，
   但系统里那个变量仍然存在，需要用户自行清理。
4. **托管 GROK_HOME 不迁移 grok 侧 `sessions/`。** 首次切换后旧底层会话恢复会失败，
   由现有链路自动新建，本地数据不丢。
5. **`managedGrokHome` 关闭时隐私开关无法保证。** 隐私状态界面会如实标出这一点，
   而不是继续显示「已关闭」。
6. **Poe、模型中心 UI、目录同步、能力检测未实现**，属 G-R7b。
   因此当前 `agentCompatible` 只有播种时写入的既成事实（DeepSeek 为 `true`，
   来自它一直在跑 Agent 链路），还没有真实的检测流程。
7. **自定义 Provider 目前只能通过代码路径创建。** `validateBaseUrl` 与注册表已就绪，
   但录入界面在 G-R7b。
8. **未实现备用模型与自动回退**，这是本轮的设计目标而非缺口。

## 十九、修改文件清单

### 新增（扩展）

```
src/privacy/managed-grok-home.ts
src/privacy/runtime-env.ts
src/privacy/secret-redactor.ts
src/privacy/privacy-status.ts
src/models/providers/provider-types.ts
src/models/providers/provider-registry.ts
src/models/providers/provider-secret-store.ts
src/models/providers/provider-validator.ts
src/models/providers/runtime-model-profile.ts
src/models/providers/grok-config-writer.ts
src/services/provider-service.ts
```

### 修改（扩展）

```
src/agent-controller.ts           Provider 服务装配、日志脱敏、模型投影、隐私状态入口
src/extension.ts                  两个新命令与只读虚拟文档
src/grok-locator.ts               resolveGrokHome 的语义注释（返回值不变）
src/model-registry.ts             ModelDescriptor 增 providerId / agentCompatible；replace 与投影
src/messages.ts                   （无改动，模型描述符结构由 model-registry 决定）
src/services/runtime-bootstrap.ts 解析启动目标、托管目录、子进程环境、画像、失败出口
src/services/model-facade.ts      providerId 落盘、切换 Provider 重启、失败不换模型
src/services/mode-service.ts      仅 Ask 模型的模式门禁
src/services/session-service.ts   providerId 依赖与写入
src/services/timeline-service.ts  失败明细脱敏
src/storage/session-repository.ts SessionRecord 增 providerId
src/storage/storage-migration.ts  SCHEMA_VERSION 3、providers kind、session v2→v3 迁移
src/storage/transcript-repository.ts 双层脱敏
src/webview/composer.ts           模型浮层按 Provider 分组与「仅 Ask」徽标
src/webview/main.css              分组标题与徽标样式
package.json                      两个命令、managedGrokHome 设置、测试清单
```

### 新增（测试）

```
tests/provider-registry.test.ts
tests/provider-secret-store.test.ts
tests/provider-validator.test.ts
tests/grok-config-writer.test.ts
tests/runtime-env.test.ts
tests/secret-redactor.test.ts
tests/managed-grok-home.test.ts
tests/session-provider-migration.test.ts
tests/privacy-status.test.ts
tests/provider-runtime-wiring.test.ts
```

### 修改（测试与 Runtime 包）

```
tests/support/vscode-stub.ts          secrets / globalState / 内容提供器 / setTextDocumentLanguage
tests/support/controller-harness.ts   secrets 与 globalState 装配、providerKey 选项
tests/timeline-persistence.test.ts    迁移断言随 SCHEMA_VERSION 3 收紧
packages/agent-runtime/src/logger.ts  registerRuntimeSecrets
packages/agent-runtime/src/agent-runtime.ts  redactValues 选项
packages/agent-runtime/src/index.ts   导出 registerRuntimeSecrets
packages/agent-runtime/tests/logger.test.ts  两项新测试
```

### 新增（文档）

```
docs/privacy/grok-network-audit.md
docs/phase-7-g-r7a-privacy-provider-report.md
```

## 二十、下一轮（G-R7b）待办

1. Poe Provider：固定配置、`/v1/models` 同步与 12 小时缓存、错误码映射、隐私提示
2. 模型中心 Webview：`src/webview/model-settings/`，Provider 列表、Key 录入、测试连接
3. HTTP 客户端与 `provider-error-mapper.ts`
4. 能力检测：基础检测与 `lingdong_capability_probe` Agent 检测
5. 自定义 OpenAI-compatible Provider 的录入界面
6. 规格第二十三、二十四节的人工验收
7. 收口报告 `docs/phase-7-g-r7-model-center-privacy-report.md`
