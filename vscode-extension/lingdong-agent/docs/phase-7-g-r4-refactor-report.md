# 阶段 G-R4：集成测试护栏、巨型文件拆分与长会话性能

本阶段不新增产品功能，目标是先补测试护栏，再在护栏保护下拆分两个巨型文件，
最后处理长会话与流式渲染的性能问题。

## 一、完成标准对照

| 标准 | 结果 | 证据 |
| --- | --- | --- |
| `agent-controller.ts` 降至 400–600 行 | 达成 | 2323 → 550 行 |
| `webview/main.ts` 只保留初始化与消息路由 | 达成 | 1295 → 236 行，仅装配与事件接线 |
| 每个业务模块独立测试 | 达成 | 新增 40 项，覆盖服务层与各 webview 模块 |
| 长会话不全量重绘 | 达成 | 恢复分页 + 增量 Markdown |
| 流式响应不卡顿、不跳动 | 达成 | 只重绘最后一个 Markdown 块 |
| 旧版 Plan 与侧边栏重复实现移除或只读化 | 达成 | 旧表单降级为只读投影 |
| 发送、恢复、重连、Plan、Diff 全链路测试通过 | 达成 | 集成测试 10 项 + 链路测试 5 项 |
| 原有 331 项测试全部保留 | 达成 | 371 项全通过（扩展 296 + Runtime 75） |

## 二、测试护栏（先做，用于保护后续重构）

重构前先让真实的 `AgentController` 可测，否则拆分过程没有任何回归信号。

**`tests/support/vscode-stub.ts`**：实现被 `src/` 真正调用到的 VS Code API 面
（`workspace` / `window` / `commands` / `languages` / `env` / `Uri` 等），
交互式 API（QuickPick、InputBox、OpenDialog、消息框）都可以在用例里预置返回值并回读调用记录。
配合 `tsconfig.test.json` 把裸导入 `vscode` 指向该桩，测试因此驱动的是真实控制器，
而不是另抽一份纯函数。

**`tests/support/controller-harness.ts`**：注入 Runtime 工厂，
让控制器连到 `packages/agent-runtime/tests/fixtures/fake-grok.mjs`，
走真实的 ACP 编解码、事件归一化与落盘，只把 Grok 进程换成夹具。

### 集成测试（`tests/agent-controller.integration.test.ts`，10 项）

连接与流式、重复发送互斥、连接失败后不卡在忙碌态、子进程异常退出作废缓存并在下次发送重新拉起、
手动重连释放旧 Runtime、停止取消底层轮次、Plan 模式注入研究约束且不请求终端命令、
文件变更形成可复核列表、未连接时切模型只记录选择、未知模型只提示。

### 链路测试（`tests/agent-controller.chain.test.ts`，5 项）

覆盖「发送 → 流式 → 落盘 → 重开恢复」：恢复出同一段对话、保留当时的工作模式、
复用已有的 Grok 会话标识、底层恢复失败时保留本地记录并新建会话、多轮对话按时间顺序落盘并按序恢复。

## 三、拆分 `agent-controller.ts`（2323 → 550）

控制器保留组合根职责：持有 VS Code 依赖、装配服务、向 Webview 推送快照。
业务逻辑下沉到 `src/services/`：

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `session-service.ts` | 668 | 会话增删改查、分组、原生菜单、落盘与恢复 |
| `change-facade.ts` | 358 | 变更列表、Diff、接受/拒绝/撤销 |
| `plan-facade.ts` | 352 | 计划记录、编辑保存、构建流转 |
| `turn-service.ts` | 342 | 单轮生命周期与事件消费 |
| `runtime-service.ts` | 293 | Runtime 启停、断线作废与退避重连 |
| `context-facade.ts` | 269 | 上下文项、用量与压缩 |
| `permission-facade.ts` | 249 | 权限队列与卡片状态机 |
| `model-facade.ts` | 199 | 模型选择与校验 |
| `workspace-tools.ts` | 161 | 文件列举、搜索与截断标记 |
| `mode-service.ts` | 143 | 模式切换与挂起意图 |
| `runtime-bootstrap.ts` | 126 | Grok 定位、版本检查与启动参数 |
| `turn-state.ts` | 29 | 轮次内共享状态 |

`session-service.ts` 仍偏大（668 行），因为会话的持久化与原生菜单交互耦合较紧；
它有独立的仓储层测试与链路测试覆盖，留作后续可选拆分，不阻塞本阶段。

## 四、拆分 `webview/main.ts`（1295 → 236）

`main.ts` 现在只做三件事：查询 DOM、构造各视图对象并互相接线、把 `window.message` 转给路由。

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `conversation.ts` | 380 | 消息流、分页、流式封口、消息级操作 |
| `message-renderer.ts` | 349 | 单条消息渲染 |
| `message-router.ts` | 343 | 宿主消息分发 |
| `composer.ts` | 285 | 输入区、上下文 chips、浮层 |
| `workbench/workbench-view.ts` | 216 | 工作台开合、宽度与工具切换 |
| `app-context.ts` | 185 | DOM 查询与前端状态 |
| `plan-controller.ts` | 135 | 计划阅读态/编辑态切换 |
| `incremental-markdown.ts` | 132 | 增量 Markdown 分块渲染 |
| `session-rail.ts` | 85 | 会话列表分组与操作入口 |
| `workbench/{changes,files,context,tasks,host}-panel.ts` | 20–68 | 各工具面板 |

## 五、旧版 Plan 与侧边栏重复实现

旧的 `plan-panel.ts`（140 行，textarea + `window.prompt` 表单）与中栏结构化编辑器构成两套发散交互，
已降级为 `side-plan-panel.ts`（47 行）只读投影：只显示标题、进度与步骤状态，
并明确引导「编辑与批准请在主面板的计划文档中进行」。
`side-changes-panel.ts`、`side-tasks-panel.ts`、`side-context-panel.ts` 同样确认为只读，
不再出现 `prompt` / `confirm` / `textarea`。计划的唯一编辑入口是主面板中间的计划文档。

## 六、长会话与流式性能

**恢复分页**：`RESTORE_PAGE_SIZE = 60`，恢复时只渲染最新一页，
其余折叠为「加载更早消息（还有 N 条）」，点击后按页补渲染并插在按钮之后以保持时间顺序。

**增量 Markdown**：`incremental-markdown.ts` 把回复按顶层块切分（围栏代码块内部的空行不切分，
未闭合围栏在流式中间算一个块，松散列表与表格不拆分），流式追加时只重绘最后一个块，
已渲染块的 DOM 节点保持同一实例，内容未变化时不产生任何渲染。这解决了此前每个 delta 都
`replaceChildren()` 整条消息导致的卡顿与光标跳动。

## 七、文件搜索截断提醒

`workspace-tools.ts` 区分两种截断并回传 `truncated` 标记：扫描到达上限、结果列表被裁剪。
`workbench/files-panel.ts` 的 `truncationNotice()` 据此渲染显式提示条
（含「结果已被截断，请用关键词缩小范围」），未截断时不显示。
此前用户看到的是一份沉默截断的列表，容易误以为工作区里只有这些文件。

## 八、验证

```
npm run typecheck   # 通过
npm test            # 296 项通过（扩展）
npm test            # 75 项通过（packages/agent-runtime）
npm run build       # 通过
```

新增 40 项：集成 10、链路 5、增量 Markdown 8、会话视图 8、工作台面板 9。
原有 331 项（扩展 256 + Runtime 75）全部保留且通过。

## 九、未处理项

- `session-service.ts` 668 行，可进一步拆出原生菜单交互。
- 侧边栏四个只读投影仍在 `package.json` 注册；若确认不再需要，可整体下线以减少一套渲染路径。
- 增量渲染只覆盖助手消息正文，工具卡片分组仍是整体重绘（单条体量小，暂未构成瓶颈）。

阶段 G-R4 结束。未开始阶段 H，未 Fork Code-OSS。
