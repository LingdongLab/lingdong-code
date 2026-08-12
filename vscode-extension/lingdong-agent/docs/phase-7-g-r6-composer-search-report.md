# 阶段 G-R6：Composer 上下文引用与对话检索 · 完成报告

## 1. G-R5 人工验收结果

六项人工验收由你在进入本阶段前完成并确认「没问题」，无缺陷需要回补，因此本阶段没有携带 G-R5 遗留问题：

| 场景 | 结果 |
| --- | --- |
| 只读分析出现「探索代码库」分组 | 通过 |
| 修改代码出现「修改代码」分组且文件数来自 ChangeTracker | 通过 |
| 修改并验证出现三组分区与真实测试结果 | 通过 |
| 停止任务后显示「已停止」且不再计时 | 通过 |
| Runtime 断线显示「Agent 连接中断」 | 通过 |
| 重启后运行中的旧 Turn 标记为 interrupted | 通过 |

## 2. @ 候选来源

候选分三组，全部由宿主装配后下发。

**快捷上下文**（固定顺序，不参与打分重排，只过滤）

| 候选 | 可用条件 | 不可用时的说明 |
| --- | --- | --- |
| 当前文件 | `activeTextEditor` 存在且在工作区内 | 当前没有打开的文件 |
| 选中代码 | 活动编辑器有非空选区 | 当前没有选中内容 |
| 问题面板 (N) | 工作区诊断条数 > 0，N 为真实条数 | 当前没有诊断信息 |
| 终端输出 | `ContextFacade.recentTerminalOutput()` 有行数 | 还没有可用的终端输出 |

不可用的候选灰显并给出原因，不静默消失。

**最近使用**（上限 5 项，保留时间顺序不按相关度重排）

三个来源合并去重：宿主订阅 `window.onDidChangeActiveTextEditor` 维护的最近打开队列（上限 20）、用户通过 @ 接受过的文件、`ChangeFacade.sessionChangedFiles()` 给出的本会话已改文件。合并时会与当前工作区文件列表求交，已删除或被排除的路径不会残留。

**工作区文件**（上限 20 项）

复用 `WorkspaceTools.collectFiles()`（`findFiles` + 既有 `WORKSPACE_EXCLUDE`，扫描上限 1000），再逐条跑 `isExcludedPath()` 过滤。目录候选从命中文件的路径前缀派生，只在查询串非空时出现，避免空查询时浮层被目录淹没；工作区列举本身不返回目录节点，这里不额外遍历文件系统。

排序为「文件名前缀 > 文件名子串 > 相对路径子串」，同分时按路径深度、字典序、输入顺序稳定排序。已出现在「最近使用」的路径不再进「工作区文件」，同一文件不会在浮层里出现两次。

本版未实现 `@Git变更`、`@网页`、`@图片`、`@MCP`、`@代码库符号`——没有真实接线的入口一律不显示。

## 3. 上下文安全边界

关键设计：**入站协议里根本没有路径字段**。

- Webview 只能回传宿主先前下发的 opaque id（`q-current-file` 等固定 id，或 `c<seq>` 序号 id）与它声称的来源类型。
- 宿主用 `candidateId` 查注册表（上限 200，按插入顺序淘汰，切换会话清空）。查不到 → 拒绝并提示「这条上下文候选已失效」；注册表里的 source 与 Webview 声称的 `sourceType` 不一致 → 拒绝并提示「上下文候选校验失败」。
- 因此伪造绝对路径不是「被校验拒绝」，而是**无处可传**：协议层面不存在这个字段。
- 解析后一律复用既有入口，本阶段没有新写任何读取或脱敏逻辑：`current-file`→`addCurrentFile()`、`selection`→`addSelection()`、`problems`→`addDiagnostics()`、`terminal`→`addTerminalOutput()`、`file`→`ContextService.addFileAtPath()`、`folder`→`ContextService.addFolderAtPath()`。后两者新增，但内部走的仍是原有的工作区边界检查、`isExcludedPath` 敏感/二进制过滤、大小限额与脱敏，文件夹保留原有的确认与 `folderFiles: 50` / `folderChars: 300_000` 限额。
- 敏感文件与二进制文件在**候选阶段就不出现**，不是等到选中才拒绝。
- 重复上下文不重复加入：候选带 `alreadyAdded` 标记，`ContextService` 侧也仍有去重。
- Chip 由既有 `renderContextChips()` 渲染，空列表照旧整体 `hidden`，不产生空胶囊。

## 4. 文件搜索与截断逻辑

新增三条消息：

| 消息 | 方向 | 校验 |
| --- | --- | --- |
| `contextSuggestQuery { query }` | Webview → Host | `query` 为字符串，超过 `SUGGEST_QUERY_MAX = 200` 截断 |
| `contextSuggestSelect { candidateId, sourceType }` | Webview → Host | `candidateId` 过 `isSafeId`（`/^[A-Za-z0-9_-]{1,64}$/`）；`sourceType` 过 `CANDIDATE_SOURCES` 枚举白名单 |
| `contextSuggestResults { query, groups, truncated, matched }` | Host → Webview | — |

性能处理：

- Webview 侧 120ms 防抖，落在规格要求的 100–150ms 区间。
- 宿主侧工作区文件列表带 5 秒 TTL 缓存，连续按键只扫一次工作区。
- 工作区组最多返回 20 项，**不把完整文件树一次性发给 Webview**。
- 被截断时下发 `truncated: true` 与截断前的真实 `matched` 数，浮层底部显示「仅显示前 20 项，请继续输入以缩小范围。」——提示放在浮层内而非发聊天 `notice`，避免打字过程中刷屏。这与 G-R4 已有的工作区截断标记是同一套语义。

## 5. Slash 命令清单

15 条，全部映射到已有真实能力：

| 命令 | 目标 | 类型 |
| --- | --- | --- |
| `/ask` `/plan` `/agent` `/auto` `/debug` | `setMode` | 宿主消息 |
| `/new` | `newSession` | 宿主消息 |
| `/stop` | `stop` | 宿主消息 |
| `/retry` | 复用消息操作栏的重试路径 | 客户端 |
| `/compact` | `compactContext` | 宿主消息 |
| `/clear-context` | `clearContext` | 宿主消息 |
| `/changes` | 打开 Changes 工作台 | 客户端 |
| `/files` | 打开 Files 工作台 | 客户端 |
| `/terminal` | `openNativeTerminal` | 宿主消息 |
| `/browser` | `openSimpleBrowser` | 宿主消息 |
| `/help` | 列出当前可用命令 | 客户端 |

## 6. Slash 允许列表与禁用规则

`SLASH_COMMANDS` 这张表**本身就是允许列表**：`findSlashCommand(id)` 只从表里取，表外的任何 id 一律返回 `undefined`，不执行。

宿主侧零新增攻击面：每条命令的 `target` 要么是 `{ kind: "host"; message }`，message 是**已有且已过 `parseWebviewMessage` 校验**的类型；要么是 `{ kind: "client"; action }`，纯 Webview 动作。没有任何「字符串 → VS Code 命令」的转发口。

禁用规则按运行时能力判定，不可用的命令保留在列表里并说明原因，而不是凭空消失：

| 依赖 | 缺失时的原因文案 |
| --- | --- |
| `switchMode`（五个模式命令） | 当前任务执行中，暂时不能切换模式 |
| `cancel`（`/stop`） | 当前没有正在执行的任务 |
| `send`（`/retry`） | 当前任务执行中，暂时不能重试 |

命令绝不作为普通消息发给模型：命中 Slash 时 `composer.submit()` 提前返回，不走 `sendPrompt`。执行成功后清空输入框、给一条轻量反馈、焦点回输入框；失败保留可恢复提示，不伪装成功。

`readSlashQuery()` 只在**首个非空字符是 `/` 且光标仍在这个词内**时才认定为命令，所以「/tmp 下的脚本坏了」这类正常提问不会被误当成命令执行。

## 7. 会话搜索范围

按你的选择，v1 收窄为只搜对话流：

**搜索**：用户消息、Agent 公开回复正文、`notice` / `error` 提示文案、Timeline 分组标题与副标题、Timeline 条目的文件相对路径。

**不搜索**：`toolOutput` 隐藏工具输出、旧版工具摘要的内部 `rawLabel`、ACP 原始帧、Output Channel 全文、模型私有推理、API Key、环境变量、未脱敏内容。

这里有两层保障：`extractSearchable()` 用白名单 `switch`，未列出的消息类型一律返回空数组（新增消息默认不进搜索源）；而 `toolOutput` 在 `message-router.ts` 里本来就被丢弃，Webview 手上根本没有这份数据。

Plan 标题/步骤与 Changes 文件名按你的决定推到下一轮，规格测试项 30、31 随之延后。

## 8. 分页定位方式

搜索放在 Webview，`ConversationView` 维护一份与 `RenderUnit` 顺序一一对应的 `SearchableRecord[]`，下标与 DOM 顺序天然对齐。

关键点是**可搜记录在渲染之前就已建立**：`MessageRouter.restore()` 在组装 units 的同一次遍历里组装 `SearchableDraft[][]`，调用 `conversation.seedSearchable(drafts)` 后才 `renderHistory()`。因此尚未渲染的更早分页同样可搜——否则搜索只能命中已渲染的最近 60 条。

命中未渲染的下标时，`revealRecord()` 循环调用既有 `loadEarlierHistory()`，**直到目标下标进入已渲染区就停**，不是一次铺开全部历史（有专门测试守着这一点）。命中折叠的 Timeline 分组时，按 `data-turn-id` / `data-group-id` 找到对应 `details` 并临时展开。

不在宿主复刻 `assistantDelta` 合并规则是刻意的：那份规则一旦两边漂移，搜索定位就会错位。

## 9. 键盘与焦点交互

输入框 keydown 的接管顺序在 `main.ts` 里显式前置委托，保持可读：

```
@ 候选浮层 → / 命令浮层 → Enter 发送
```

| 按键 | 行为 |
| --- | --- |
| `@` / `/` | 打开对应浮层，继续输入实时过滤 |
| ↑ ↓ | 在候选间移动 |
| Enter / Tab | 确认候选 |
| Escape | 关闭浮层，焦点回输入框 |
| 鼠标点击 | 等价于确认 |
| `Ctrl/Cmd+F` | 打开会话查找条 |
| 查找条内 Enter / Shift+Enter | 下一个 / 上一个（循环） |
| 查找条内 Escape | 关闭并清除高亮 |

`composer.closeAllPopovers()` 扩展为同时关闭两个建议浮层，因此 Escape 的既有「先关浮层，再停止任务」语义继续成立。document 级 Escape 先给查找条处理。

没有往 `package.json` 加 `ctrl+f` keybinding，面板创建时也未开 `enableFindWidget`，所以不影响 VS Code 编辑器自身的全局查找。

现有「+」菜单完整保留，作为完整上下文入口；@ 补全不要求用户先开菜单。

## 10. 新增测试数量

新增 **66 项**（规格要求约 35 项，除延后的 Plan/Changes 搜索两项外全部覆盖）：

| 文件 | 项数 | 覆盖 |
| --- | --- | --- |
| `tests/context-candidates.test.ts` | 9 | 过滤、排序、最近前置、20 项上限、截断文案、只含相对路径、`alreadyAdded`、`@token` 识别 |
| `tests/context-suggestion-service.test.ts` | 11 | 注册表命中/未命中、`sourceType` 不一致被拒、协议无路径字段、敏感与二进制不进候选、重复不重复加入、可用性判定、TTL 缓存 |
| `tests/suggestion-popup.test.ts` | 12 | 输入 `@` 打开、逐字过滤、上下键、Enter/Tab 确认、Escape 关闭并回焦、生成正确 Chip、无上下文不渲染空 Chip、截断提示不发 notice |
| `tests/slash-command.test.ts` | 7 | `/` 触发、`/pla` 过滤、未注册 id 被拒、忙时禁用及原因、正常提问不误触发 |
| `tests/slash-suggestions.test.ts` | 12 | `/plan`→`setMode`、`/new`→`newSession`、`/stop`→`stop`、`/retry` 重试路径、`/compact` 不产生 `sendPrompt`、成功后清空输入框、`/help` |
| `tests/conversation-search.test.ts` | 15 | 搜用户消息与回复、搜 Timeline 标题与文件路径、上一个/下一个循环、无结果、清除高亮、定位未加载分页且逐页加载、隐藏工具输出与私有推理不进搜索源 |

## 11. 最终测试结果

| 项目 | 结果 |
| --- | --- |
| 扩展测试 | **422 / 422 通过**（356 → 422） |
| Runtime 测试 | **75 / 75 通过** |
| 合计 | **497 项通过**（原 431 项全部保留，无删除、跳过或弱化） |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过 |

过程中修了一处测试基建问题：`tests/support/vscode-stub.ts` 缺 `window.onDidChangeActiveTextEditor` 与 `FileType`，导致 15 项 Controller 集成测试报 `not a function`。补齐 stub 后恢复，不是产品代码缺陷。

## 12. 三项人工验收

以下需要在 Extension Development Host 里执行，本报告不代填结果：

**@ 补全**：在 Composer 输入 `@`，确认显示快捷上下文与最近文件、能搜工作区文件、键盘操作正常、选择后生成 Chip、不显示绝对路径、发送后上下文按既有规则一次性消费。

**Slash**：依次测 `/plan`、`/new`、`/compact`、`/changes`、`/terminal`，确认都调用真实本地能力、不作为普通消息发送、状态正确、不存在假入口。

**会话搜索**：在长会话中搜一个文件名，确认结果数量正确、能前后跳转、命中 Timeline 详情可定位、命中未加载分页会自动加载、关闭后高亮消失。

## 13. 已知限制

1. **Plan 与 Changes 未进搜索范围**。按你的选择，v1 只搜对话流。这两处的内容不在 `ConversationView` 的渲染单元里，要么得让工作台面板也贡献可搜记录，要么把搜索移回宿主，都不适合塞进本轮。规格测试项 30、31 随之延后。
2. **`/help` 是纯客户端命令**，只列出当前可用命令，不产生宿主调用。
3. **`/retry` 复用消息操作栏的重试路径**，语义与手动点重试完全一致：新建 turnId，旧 Timeline 保留。
4. **目录候选只在查询串非空时出现**。空 `@` 时浮层只给快捷上下文、最近文件与文件候选，否则顶层目录会占满浮层。
5. **最近打开队列不跨会话持久化**，切换会话即清空（与候选注册表同步清空，避免旧 id 在新会话里仍然可用）。
6. **单条记录最多标 50 处高亮**，超长文本不会产生上万个高亮节点。
7. **搜索为大小写不敏感的子串匹配**，不支持正则或整词匹配。
8. **三处偏离规格第十三节的「建议新增文件」**（见下）。

### 三处偏离及理由

**不新增 `src/services/slash-command-service.ts`。** 15 条命令全部能映射到已有且已过校验的消息或纯 Webview 动作。若新增一条 `slashCommand { commandId }` 通道，等于在宿主开一个「字符串 → 能力」的转发口，正是规格第十四节禁止的形态。命令表放纯数据层做允许列表，宿主侧零新增攻击面。

**不新增 `src/services/conversation-search-service.ts`，搜索放 Webview。** 宿主搜 transcript 要在宿主复刻 `message-router.restore()` 的 `assistantDelta` 合并规则才能算出 RenderUnit 下标（`assistantEnd` 不产生 unit），这份规则一旦两边漂移，搜索定位就会错位。改为在 `ConversationView` 保留有序可搜记录，下标与 DOM 顺序天然对齐。安全性不降级：Webview 手里的内容宿主已脱敏，且 `toolOutput` 在 message-router 本就被丢弃。

**保留 `src/services/context-suggestion-service.ts`。** 这个确实需要宿主：候选注册表、工作区搜索、最近文件追踪、可用性判定都只能在宿主做。

## 14. 修改文件清单

### 新增

纯数据层

- `src/composer/context-candidate.ts`
- `src/composer/slash-command.ts`
- `src/search/search-result.ts`

宿主端

- `src/services/context-suggestion-service.ts`

Webview

- `src/webview/suggestion-popup.ts`
- `src/webview/suggestion-popup.css`
- `src/webview/composer/context-suggestions.ts`
- `src/webview/composer/slash-suggestions.ts`
- `src/webview/conversation-search.ts`
- `src/webview/conversation-search.css`

测试

- `tests/context-candidates.test.ts`
- `tests/context-suggestion-service.test.ts`
- `tests/suggestion-popup.test.ts`
- `tests/slash-command.test.ts`
- `tests/slash-suggestions.test.ts`
- `tests/conversation-search.test.ts`

### 修改

| 文件 | 改动 |
| --- | --- |
| `src/messages.ts` | 三条新消息类型与入站校验 |
| `src/webview-message-handler.ts` | 两条入站消息路由 |
| `src/agent-controller.ts` | 装配 `ContextSuggestionService`、`activeFileInfo()`、`applyContextCandidate()`、订阅活动编辑器变化、新会话时 `reset()` |
| `src/services/context-facade.ts` | `addFileAtPath` / `addFolderAtPath` / `addedKeys` |
| `src/context-service.ts` | 从 `pickFolder` 抽出 `addFolder`，新增 `addFileAtPath` / `addFolderAtPath` / `resolveInside` |
| `src/services/change-facade.ts` | `sessionChangedFiles()` |
| `src/services/workspace-tools.ts` | `collectFiles()` 与 `SUGGEST_SCAN_LIMIT` |
| `src/agent-panel.ts` | 查找条与两个建议浮层容器节点 |
| `src/webview/app-context.ts` | `AppElements` 新增三个元素 |
| `src/webview/main.ts` | 装配三个组件、键盘接管顺序、`Ctrl/Cmd+F`、`closeExtraPopovers`、消息后 `search.refresh()` |
| `src/webview/composer.ts` | `interceptSubmit` 与 `closeExtraPopovers` 钩子 |
| `src/webview/conversation.ts` | 可搜记录、`seedSearchable`、`stamp`、`revealRecord` |
| `src/webview/message-router.ts` | restore 时组装并 seed 可搜记录、路由 `contextSuggestResults` |
| `tests/support/vscode-stub.ts` | 补 `onDidChangeActiveTextEditor` 与 `FileType` |
| `package.json` | 测试脚本登记六个新测试文件 |

---

阶段 G-R6 完成。未开始阶段 H，未 Fork Code-OSS，未打包独立安装程序。
