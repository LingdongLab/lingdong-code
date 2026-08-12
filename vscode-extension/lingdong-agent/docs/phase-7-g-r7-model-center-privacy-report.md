# 阶段 G-R7 报告：模型中心、隐私边界与 Poe Provider

本报告覆盖 G-R7b-2（Poe Provider），并汇总它与 G-R7a（隐私边界）、G-R7b-1（模型中心基础）
的衔接关系。G-R7a 与 G-R7b-1 的细节见
[phase-7-g-r7a-privacy-provider-report.md](./phase-7-g-r7a-privacy-provider-report.md)
与 [phase-7-g-r7b1-model-center-report.md](./phase-7-g-r7b1-model-center-report.md)。

## 一、这一轮做了什么

在既有的 Provider / HTTP / SecretStorage / 能力检测之上接入 Poe，没有新建第二套编排：

- Poe 是一份写在代码里的固定模板，用户在模型中心点一下才写入配置
- 模型目录来自 `GET {baseUrl}/models`，落盘缓存 12 小时，可随时手动刷新
- 目录界面支持搜索、按厂商与协议筛选、分批渲染与「已添加」标记
- 添加模型走既有 `addModel` 路径，因此自动获得三步测试与能力检测
- 积分余额只在用户点击时查询，内存缓存 5 分钟
- Poe 详情页固定显示中转数据流向的隐私说明

## 二、Poe 进入列表的方式：模板卡片，而不是播种

`ProviderRegistry.load()` 的播种逻辑一行未动。这不是实现上的偷懒，而是两条考虑：

1. 播种会让每个既有安装凭空多出一个没配凭据的服务商，语义上说不通
2. 「注册表初次只有 DeepSeek」是既有测试的断言，也是用户对现有行为的预期

取而代之的是 [provider-types.ts](../src/models/providers/provider-types.ts) 里的
`poeProvider()` 固定模板：`baseUrl` 为 `https://api.poe.com/v1`，协议 `responses`，
`enabled: false`、`models: []`。`publish()` 在 `providers` 消息里附带 `availableBuiltins`
（尚未添加的模板），首页据此渲染一张「添加 Poe」卡片，点击后发 `addBuiltinProvider`。

地址与协议都不由界面传入，因此这条路径不需要自定义 Provider 那套 `validateBaseUrl`
与数据流向确认。启用规则与自定义 Provider 一致：首个模型测通后才由 `applyOutcome` 启用。

## 三、目录同步与缓存

新增三个纯逻辑文件加一个编排层：

| 文件 | 职责 |
| --- | --- |
| [poe-catalog.ts](../src/models/providers/poe-catalog.ts) | 逐条容错解析、协议推断、12 小时新鲜度判定 |
| [catalog-cache.ts](../src/models/providers/catalog-cache.ts) | JsonStore 落盘到 `<storageRoot>/agent-providers/catalogs/<providerId>.json` |
| [poe-balance.ts](../src/models/providers/poe-balance.ts) | 余额响应的候选键解析 |
| [poe-catalog-service.ts](../src/services/poe-catalog-service.ts) | 缓存判定、发请求、失败保留旧缓存、余额短时缓存 |

解析的态度是逐条容错：除 `id` 外全部可选，未知字段忽略，坏条目只累加 `skipped`。
`id` 无法通过远端模型名校验时同样计入 `skipped`——目录里不该出现「看得见、加不进」的条目。
`supported_endpoints` 的写法在不同服务商之间并不统一，因此按子串识别，
输出顺序固定为 Responses 在前，避免同一个模型因为响应顺序不同而拿到不同的初始协议。

`storage-migration.ts` 增加了 `"catalog"` 这一 `StorageKind` 与恒等迁移，
`SCHEMA_VERSION` 未改动——这是新增的数据种类，没有既有结构需要迁移。
`ModelSettingsService` 里那个为本轮预留的空壳 `deleteCatalogCache` 现在真的删缓存文件与备份。

失败处理只有一条规则：**保留旧缓存**。刷新失败时界面照常渲染既有条目并标注来自缓存，
另配一条按 `ProviderErrorCode` 生成的错误说明。一次网络抖动不该让用户丢掉整份列表。

## 四、积分余额：唯一改动 HTTP 客户端的地方

Poe 的余额端点是 `https://api.poe.com/usage/current_balance`，在 `/v1` 之外，不能用 `{baseUrl}` 拼。
[provider-http-client.ts](../src/models/providers/provider-http-client.ts) 因此改成判别式目标：

```ts
export type ProviderPath = "/models" | "/chat/completions" | "/responses";
export type ProviderOriginPath = "/usage/current_balance";
export type ProviderTarget =
  | { base?: "baseUrl"; path: ProviderPath }
  | { base: "origin"; path: ProviderOriginPath };
```

两个分支互不交叉，`/usage/current_balance` 在类型上就接不到 `baseUrl` 分支，
「Webview 传不进任意 URL」这条结构性保证仍然成立。

行为约束：只在用户点击时请求，不轮询；按 Provider 在内存里缓存 5 分钟；
不写会话、Timeline 或缓存文件。

## 五、添加模型与协议选择

从目录添加与手动填写走的是同一条 `addModel` 路径，因此都得到
`id = poe:<远端名>`、`remoteModelId = <远端名>`、`verified: false`、能力全 false，
随后立即执行连接 → 流式 → 能力检测三步。发给 Poe 的 `model` 取 `apiModelIdOf()`，
永远是不带 `poe:` 前缀的远端名。

协议初值的规则是：目录声明了就以目录为准（Responses 优先），没声明才沿用界面选择，
测通的协议由既有 `applyOutcome` 写回。正常任务失败时不切协议这条约束由既有代码保证，本轮未动。

`supported_features` 只进入界面的提示与筛选，**不参与 Agent 能力判定**。
能不能进 Agent 只有 `lingdong_capability_probe` 的本地检测说了算，界面文案也如实说明要测过才算。

## 六、隐私处理

- `POE_API_KEY` 早已在 [runtime-env.ts](../src/privacy/runtime-env.ts) 的 `CREDENTIAL_DENY_LIST` 中，子进程环境无需改动
- Key 只进 SecretStorage，`providers.json`、目录缓存与全部出站消息里都没有它
- 目录缓存的结构里没有凭据字段，存的是公开目录与同步时间
- Poe 详情页固定显示：使用 Poe 模型时，任务中的消息、代码片段和工具结果将发送到 Poe，
  并可能由 Poe 转交给所选模型的上游服务商
- 余额解析失败时只说「找不到可识别的积分字段」，不回显原始响应——那里面可能有账号信息

## 七、新增测试（52 项，四个文件）

全部显式登记进 `package.json` 的 `test` 脚本。

| 文件 | 项数 | 覆盖 |
| --- | --- | --- |
| `tests/poe-catalog.test.ts` | 11 | 真实形状解析、可选字段、未知字段、坏条目只跳过、非法 ID 计入 skipped、重复 ID、协议推断、12 小时新鲜度、模块 import 清单 |
| `tests/poe-catalog-cache.test.ts` | 8 | 命中缓存不发请求、过期重拉、`force` 绕过、失败保留旧缓存、无 Key 不发请求、缓存文件不含 Key、删除 Provider 连带删缓存、损坏缓存回落 |
| `tests/poe-provider.test.ts` | 19 | 模板固定配置、Key 只进 SecretStorage、不自动添加模型、本地与远端 ID 分离、协议初值、三步测试两种结论、401/402/403/404 文案、429 退避、余额三种情形、日志与落盘不含 Key、DeepSeek 无回归 |
| `tests/poe-catalog-view.test.ts` | 14 | 搜索、厂商与协议筛选、已添加徽标、首屏 50 与加载更多、换条件重置、最后同步时间、隐私说明、模板卡片、`supported_features` 不产生 Agent 结论 |

## 八、验收结果

| 项目 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| 扩展 `npm test` | 633 项全部通过（原 581 + 新增 52） |
| `packages/agent-runtime` `npm test` | 77 项全部通过 |
| `npm run build` | 通过 |

原有 658 项（扩展 581 + Runtime 77）一项未删、未跳过、未弱化。

## 九、已知限制

1. **积分字段名待真实 Key 验证。** 余额端点的响应结构无法离线确认，
   `parsePoeBalance` 按 `compute_points_available` / `compute_points_balance` /
   `current_balance` / `balance` / `points` / `credits` 依次取第一个有限数值，
   并额外看一层 `data` 嵌套。全部落空时给出明确的解析失败提示。
   人工验收时需用真实 Key 确认字段名，必要时补进候选列表。
2. **目录字段以公开文档与常见形态为准。** `architecture` 与 `pricing` 的具体结构可能变化，
   两者都按「解析不出就不显示」处理，不影响添加模型。
3. **`messages`（Anthropic 形态）协议未纳入测试与候选**，与 G-R7b-1 一致。
4. 编辑期间发现工具在改写约 20 KB 以上、含大量中文的源文件时会丢失非 ASCII 字符，
   `model-settings-service.ts` 曾被整文件转成 ASCII，已从构建产物的 sourcemap 完整恢复并复核。
   本轮对该文件的改动改用脚本按锚点拼接完成。

## 十、修改文件清单

新增：

- `src/models/providers/poe-catalog.ts`
- `src/models/providers/catalog-cache.ts`
- `src/models/providers/poe-balance.ts`
- `src/services/poe-catalog-service.ts`
- `tests/poe-catalog.test.ts`
- `tests/poe-catalog-cache.test.ts`
- `tests/poe-provider.test.ts`
- `tests/poe-catalog-view.test.ts`
- `docs/phase-7-g-r7-model-center-privacy-report.md`

修改：

- `src/models/providers/provider-types.ts`（Poe 模板、内置模板白名单、`isRemoteModelId`）
- `src/models/providers/provider-http-client.ts`（判别式目标与 origin 拼接）
- `src/model-settings-messages.ts`（三条入站、两条出站、`availableBuiltins`）
- `src/services/model-settings-service.ts`（模板添加、目录同步、余额、缓存删除、协议初值）
- `src/agent-controller.ts`（注入 `CatalogCache`）
- `src/storage/storage-migration.ts`（`"catalog"` kind）
- `src/webview/model-settings/model-catalog-view.ts`（目录界面）
- `src/webview/model-settings/model-settings-view.ts`（隐私说明、余额按钮、目录接线）
- `src/webview/model-settings/provider-list-view.ts`（内置模板卡片）
- `src/webview/model-settings/model-settings-state.ts`、`main.ts`、`model-settings.css`
- `tests/support/model-settings-harness.ts`（目录缓存依赖）
- `tests/timeline-persistence.test.ts`、`tests/model-settings-view.test.ts`（跟随新增字段）
- `package.json`（登记四个新测试文件）


## 联调修复：选了模型却连不上

真机联调发现三个问题，本节记录成因与修法。

### 1. 模型选择没有持久化的落点（主因）

现象：配好 Poe、在 Composer 里选了 Poe 模型，连接时仍然报
「模型服务商「DeepSeek」已被禁用」或「此会话原来使用 DeepSeek · DeepSeek V4 Flash，但对应凭据已不存在」。
生成的 `config.toml` 其实完全正确（`default = "poe:claude-opus-4.8"`），错的是启动时解析用哪个模型的那一步。

成因：`RuntimeBootstrap.start()` 只从两个地方取模型——当前会话记录，或设置项 `lingdongAgent.model`
（默认 `deepseek-v4-flash`）。而 `ModelFacade.select` 把选择写进内存 UI 状态和会话记录。
没有会话记录时（首次使用、上一个会话被删、记录损坏），选择无处存放，
每次启动都退回设置项的默认值。`patchSessionModel` 在这种情况下静默返回 `undefined`，
界面却照样提示「已选择模型 X（将在连接后生效）」。

修法：新增 `src/model-selection.ts`，把「最后一次选中的 Provider + 模型」这一对存进 `workspaceState`。
不写 `settings.json`——那是用户自己写的配置，设置项继续只作为初始默认值。
启动解析的优先级改为：当前会话记录 → 上次选择 → 设置项。
`ModelFacade` 在每次 `select` 时落地这一对，`currentModelId()` 与「是否换了 Provider」的判断也读它，
后者保证没有会话记录时换 Provider 一样会重启子进程换凭据。

### 2. Poe 模板默认协议选错

现象：`poe:kimi-k3` 打 `/responses` 返回 400。

成因：Poe 模板的协议初值是 Responses。实测目录里 329 个模型只有 47 个声明支持 Responses，
其余 263 个不声明 `supported_endpoints`，会退回模板的初值，每一个都要先吃一个 400。

修法：模板协议改为 `chat_completions`（Poe 上通用性最好的端点）。
目录里明确声明 Responses 的模型仍然按目录走，不受影响。

### 3. 模板改了，存量安装跟不上

内置模板的地址与协议是模板固定的，界面上没有改它们的入口，但磁盘上存的是旧值。
`ProviderRegistry` 读取时对内置模板重新从模板取 `baseUrl` 与 `protocol`，
已经装好的用户不必删掉重加。自定义 Provider 的这两个字段原样保留。

### 验证

- 新增 `tests/model-selection.test.ts`（8 个）：选择的存取与残缺数据、没有会话记录时的记住与读取、
  换 Provider 的识别，以及两个端到端回归——只配 Poe 时不选模型会明确报设置项里的那个模型，
  选过之后能连上 Poe 并只注入 `LINGDONG_KEY_POE`；重开扩展仍然记得。
- `tests/provider-registry.test.ts` 增 2 个：内置模板纠正、自定义 Provider 不被动。
- `tests/poe-provider.test.ts` 增 1 个：未声明协议的模型不会被打到 `/responses`。
- 扩展 644 个测试、Runtime 77 个测试全通过，typecheck 与 build 干净。

修改：

- `src/model-selection.ts`（新增）
- `src/services/model-facade.ts`（记住选择、优先级、换 Provider 的判断）
- `src/services/runtime-bootstrap.ts`（启动解析读上次选择）
- `src/agent-controller.ts`（接线，`AgentControllerDeps.selection` 供测试注入）
- `src/models/providers/provider-types.ts`（Poe 模板协议）
- `src/models/providers/provider-registry.ts`（内置模板纠正）
- `tests/support/controller-harness.ts`（`workspaceState`、`extraProviders` 预置）
