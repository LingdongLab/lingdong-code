# 灵动 Agent · 现状盘点与优化清单

生成时间：2026-08-05
版本：`0.1.0`
范围：`vscode-extension/lingdong-agent` + `packages/agent-runtime`
测试状态：扩展 235/235 通过，Runtime 72/72 通过

---

## 零、一句话结论

底层能力（ACP 运行时、快照撤销、权限队列、会话持久化）已经比较扎实，
但产品层仍是原型手感。"不够好用"主要来自三件事：

1. 两个巨型文件（`agent-controller.ts` 2323 行、`webview/main.ts` 1295 行）导致每次改动风险高、迭代慢。
2. 对话区缺少 Cursor 级别的基础交互（复制、重试、编辑重发、@ 内联补全、快捷键、会话内搜索）。
3. Grok 子进程异常退出后，扩展侧仍持有已死的 runtime 缓存，用户不点"重连"就一直处于静默故障状态。

---

## 一、已实现的功能

### 1.1 模式系统

| 模式 | Runtime 映射 | 行为 | 位置 |
| --- | --- | --- | --- |
| Ask | `ask` | 允许读；写/删拒绝；执行需确认 | `packages/agent-runtime/src/safety-policy.ts` |
| Plan | `plan` | 只允许读/搜索/诊断；写、删、执行全部拒绝 | 同上 |
| Agent | `agent` | 低风险读自动放行；写/删/执行需确认 | 同上 |
| Auto | `auto` | 低风险自动；工作区内写自动；高风险拒绝 | 同上 |
| Debug | UI 专用，下发为 `ask` | 本地相位机 `collect → propose → await_confirm → fixing → verify`，确认修复后切 Agent | `src/agent-controller.ts` |

配套已实现：任务执行中禁止切模式（`src/ui-state.ts`），切换意图挂起后补发；
Ask/Debug 下的写意图拦截卡片（`src/ask-intent.ts`）；模式随会话持久化。

### 1.2 会话管理

新建、打开、恢复、重命名、固定、归档、删除、搜索、启动自动恢复最近会话、首轮自动命名，
全部已打通。入口有三处：主面板左栏、活动栏会话树（`src/session-tree.ts`）、QuickPick 历史。

存储布局：

```
<globalStorage>/agent-sessions/<workspace-hash>/
  index.json
  <sessionId>/session.json | transcript.json | turns.json | plans.json
<globalStorage>/agent-snapshots/<workspace-hash>/<sessionId>/<turnId>/
  manifest.json + files/<hash>
```

### 1.3 Plan 工作流（G-R2.3 后已重构）

- Grok 原生计划审批：`plan_review_requested` → 批准/拒绝/修订，走 ACP。
- 本地计划仓储：草稿 / 待审 / 已批准 / 执行中 / 暂停 / 完成 / 放弃 / 取消。
- 阅读态文档视图与编辑态分离：`src/webview/plan/plan-document-view.ts`、`plan-editor-view.ts`。
- 步骤为独立结构化组件，支持增删、上移下移、拖拽、绑定文件；文件只显示相对路径。
- 开始构建：`src/plan-build.ts` 编译提示词并切换 Agent 模式。
- 计划归档为 Markdown：`.lingdong/plans/<date>-<slug>.md`。
- 右侧工作台只提供精简版 Plan（标题、进度、步骤状态、构建/保存）。
- Plan 模式研究流程改造：`src/plan-research.ts` 注入引导，优先用宿主安全能力而非 `Get-ChildItem`。

### 1.4 变更与 Diff

`ChangeTracker` + `SnapshotStore` 已完整：写前快照、sha256 冲突检测、单条接受/拒绝、
全部接受、整轮撤销、外部改动冲突时提供"保留当前"或 `.lingdong-before` 恢复副本、
会话恢复时重新校验。Diff 通过虚拟文档 `lingdong-snapshot:` 打开。

### 1.5 权限

风险分级（命令、内联脚本、清单文件、敏感路径）、按模式决策、会话级规则缓存、
单卡队列（上限 50）、宿主二次校验工作区边界、超时自动拒绝（默认 300s，可配置）、
高风险禁用"本会话允许"、连续拒绝提示、重连时清空会话规则。

### 1.6 上下文

已支持的来源：当前文件、选中代码、文件夹（有条数与字符上限）、终端输出、问题面板诊断。
配套：脱敏、二进制与敏感文件排除、单轮一次性消费、用量统计（精确/估算/不可用三态）、
阈值分级、手动压缩（在 Grok 支持时探测启用）。
Webview 只拿到标签，不拿内容。

### 1.7 模型

`ModelRegistry` 目前只有一个内建可用模型 `deepseek-v4-flash`，本地列表、无网络请求，
选择结果随会话持久化。自动选择、自定义模型、视觉能力均为显式禁用状态。

### 1.8 UI 外壳

主面板三栏：左栏（会话、搜索、工具快捷入口）+ 中栏（消息 + Composer）+ 右侧动态工作台。

动态工作台（G-R2.2 交付）：工具可开可关、可切换、宽度可拖（280px ~ 窗口 50%）、
状态存 `vscode.getState`、低于 1200px 以抽屉覆盖且不遮挡 Composer。
已启用工具：Changes / Files / Tasks / Context / Plan；Terminal 与 Browser 走 VS Code 原生命令。

辅助侧边栏另有 Plan / Tasks / Changes / Context 四个精简 webview；
活动栏聊天视图只是启动器，不重复渲染聊天。

### 1.9 工具事件渲染

ACP 事件 → `EventPresenter` → webview 聚合（`tool-aggregate.ts`）→ 中文动词标签
（已读取 / 已修改 / 已执行命令 / 已搜索 …），按 `toolCallId` 分组、3 秒内同一身份去重，
不同文件不去重。助手 Markdown 走 markdown-it + DOMPurify。

### 1.10 存储与持久化

`JsonStore` 原子写（`.tmp` → `.bak` → rename）、读取时主档失败回退备份、
损坏归档为 `.corrupt-<ts>`、Schema 信封与版本校验。
转录有脱敏与 2000 条上限，重启后权限卡过期。快照按天数与总量清理。

### 1.11 命令

`package.json` 中注册并接线的命令共 33 个，覆盖打开面板、会话增删改查、模式切换、
计划批准/构建/暂停/保存、上下文添加、Diff 与撤销、压缩上下文、重连、查看日志等。

### 1.12 测试

扩展 31 个测试文件 235 个用例，Runtime 14 个文件 72 个用例，覆盖消息校验、状态机、
变更追踪、快照、存储、计划仓储与 UI、上下文、权限、事件规范化、风险策略等。

---

## 二、明确禁用或未实现

| 项 | 状态 | 位置 |
| --- | --- | --- |
| Preview 工作台工具 | 禁用（暂未配置） | `src/webview/workbench-state.ts` |
| Skills | 禁用 | Composer `+` 菜单 |
| MCP 服务 | 禁用 | Composer `+` 菜单 |
| 图片 / 视觉输入 | 禁用（无视觉模型） | `src/model-registry.ts` |
| Multitask | 禁用 | `src/webview/main.ts` |
| 扩展商店 | 禁用 | `src/webview/main.ts` |
| 自定义模型 | 禁用 | `src/webview/main.ts` |
| Auto 模型选择 | 模型数 < 2 时禁用 | `ModelRegistry.canAutoSelect()` |
| 账号 / 登录 UI | 不伪造，只打开设置 | `agent-controller.openSettings()` |
| `@Git 变更` 上下文 | 未实现 | `docs/phase-5-e-report.md` |
| Schema 迁移 | 只有框架，迁移表为空 | `src/storage/storage-migration.ts` |
| 删除会话时清理 Grok 侧数据 | 未调用，仅提示 | `src/storage/session-repository.ts` |

---

## 三、需要优化的地方（按影响排序）

### P0-1　Grok 进程死亡后 runtime 缓存不失效【可靠性缺陷】

Runtime 层处理正确：`acp-client.ts` 在 transport `exit` 且非预期时会 `failAll`。
但扩展层没有据此作废缓存：

```2127:2133:E:\LingdongCode\vscode-extension\lingdong-agent\src\agent-controller.ts
  private ensureStarted(): Promise<AgentRuntime> {
    this.startup ??= this.startRuntime().catch((error: unknown) => {
      this.startup = undefined;
      throw error;
    });
    return this.startup;
  }
```

`this.startup` / `this.runtime` 只在 `disposeRuntime()` 中清空，而它只有手动重连和扩展销毁会调用。
`connection: "failed"` 也只在发送失败（L1101）和重连失败（L1336）时才发出，
子进程异常退出本身不会改状态。

后果：Grok 崩溃后 UI 可能仍显示"就绪"，下一次发送才失败，用户必须自己发现"重连"按钮。

建议：在 `handleEvent` 收到进程退出/致命错误时调用 `disposeRuntime()`、
广播 `connection: failed`、禁用发送，并提供一次自动重连（带退避）。改动量约 50 行。

### P0-2　两个巨型文件

| 文件 | 行数 | 问题 |
| --- | ---: | --- |
| `src/agent-controller.ts` | 2323 | 会话、运行时、计划、变更、权限、存储、上下文、UI 推送全在一个类 |
| `src/webview/main.ts` | 1295 | 布局、会话列表、Composer、消息、Plan 中栏、工作台、所有右侧面板、事件路由 |

建议拆分：控制器切成 `RuntimeService` / `SessionService` / `ChangeFacade` / `PlanFacade`，
目标每个 < 400 行；webview 抽出 `panels/changes.ts`、`panels/context.ts`、`panels/tasks.ts`，
复用 `plan/dom.ts` 已有的 DOM 工具。

### P0-3　对话区交互缺失（与 Cursor 的主要体感差距）

| 期望能力 | 现状 |
| --- | --- |
| 编辑并重发用户消息 | 无 |
| 重新生成 / 重试 | 无 |
| 复制整条消息 | 只有代码块有复制按钮（`message-renderer.ts` L290） |
| 中途停止的视觉反馈 | 能停，但没有"已停止/部分输出"标记 |
| Composer 内联 `@` 补全 | 无，只有 `+` 菜单弹窗 |
| 快捷键 | 只有 Enter / Shift+Enter / Esc；`package.json` 没有任何 `keybindings` |
| 会话内搜索 | 无（只有会话列表搜索） |
| Slash 命令 | 无 |
| 对话级检查点回滚 | 只有文件级快照与整轮撤销，没有"回到第 N 条消息" |

另外会话右键菜单还在用 `window.prompt` / `window.confirm`
（`main.ts` L414–421、`plan-panel.ts` L79/L92），观感明显低于 VS Code 原生水准。

### P1-1　性能：全量重绘，无虚拟化

- `#messages-inner` 没有虚拟化，长会话 DOM 无上限增长。
- 各面板刷新普遍用 `replaceChildren()`（`main.ts` 中约 15 处）。
- 会话恢复时清空后整段重放转录，每条助手消息都重新做一次完整 Markdown 渲染。
- 流式输出每 80ms 一次 `body.innerHTML = renderMarkdownToHtml(...)`，全量重新解析与消毒。
- `findFiles` 静默截断：工作区文件列表 400→200、Plan 研究概览 120、上下文选择 3000，
  超限时用户没有明确提示。

### P1-2　面板逻辑三份重复

Tasks / Changes / Context 在主面板和辅助侧边栏各有一套渲染；
`changes-panel.ts` 甚至直接提示用户去主面板操作。
`plan-panel.ts`（140 行）是旧版简化表单，和中栏的结构化编辑器构成两套发散的 Plan 交互，建议直接删除或改为只读投影。
CSP/HTML 外壳生成在 `side-panels.ts`、`agent-panel.ts`、`chat-view-provider.ts` 三处重复。

### P1-3　多根工作区与无工作区

全链路默认取 `workspaceFolders[0]`（运行时启动、文件列举、打开文件、会话推送、
Plan 概览、存储 bootstrap、上下文服务）。多根工作区下其余根不可见，也没有根切换器。
无工作区时能打开面板但发送必然失败。建议会话记录所属根，多根时提供选择器。

### P1-4　并发与错误吞没

- `sendPrompt` 入口没有互斥锁，UI 卡顿时双击发送会落到 runtime 的"上一轮仍在执行"。
- 控制器中多处 `void this.flushPersistence()`，失败只进日志。
- `void handleWebviewMessage(...)`（`agent-panel.ts` L39、`chat-view-provider.ts` L39、
  `side-panels.ts` L53）在处理器抛出时可能产生未捕获的 Promise rejection。
- 重连完全靠手动，没有自动重试与退避。

### P2-1　可访问性与国际化

`lang="zh-CN"` 与全部中文文案硬编码在 UI 代码里，没有接入 VS Code `l10n`。
Composer 的 `+`、发送、停止、模型按钮缺 `aria-label`；弹层打开时不做焦点收拢与归还。
浅色主题只有 3 处显式覆盖，徽章、工具卡、风险色在浅色下有对比度风险。

### P2-2　测试盲区

以下关键路径完全没有单元测试：`agent-controller.ts`、`extension.ts` 激活、
`webview-message-handler.ts` 路由、`webview/main.ts` 接线、`context-service.ts`、
`session-persistence.ts`，以及"发送 → 流式 → 落盘 → 恢复"的集成链路
（目前只有 `scripts/live-*.mjs` 这类需要真实环境的脚本）。
这意味着拆分两个巨型文件时只能靠手工回归。

### P2-3　配置与打包

`package.json` 默认配置把 `grokExecutable`、`grokHome` 硬编码为 `E:\LingdongCode\grok\...`，
换机器即失效，应改为空值 + 首启引导。版本仍是 `0.1.0`，无 keybindings、无 walkthrough。

---

## 四、建议的推进顺序

| 序号 | 事项 | 预期收益 | 粗略成本 |
| --- | --- | --- | --- |
| 1 | Grok 生命周期修复：退出即作废缓存 + 状态置 failed + 自动重连一次 | 消除静默故障 | 小 |
| 2 | 对话区 MVP：整条复制、重试上一条、停止标记 | 直接提升日常手感 | 小 |
| 3 | Composer 内联 `@` 补全（复用 `listWorkspaceFiles`） | 去掉弹窗路径 | 中 |
| 4 | 会话右键菜单改用宿主 QuickPick / InputBox，去掉 `window.prompt` | 观感对齐 VS Code | 小 |
| 5 | `package.json` 补 keybindings（发送、停止、新建会话、打开面板） | 键盘流 | 小 |
| 6 | 拆分 `agent-controller.ts` 与 `webview/main.ts` | 后续迭代提速 | 大 |
| 7 | 删除或降级 `plan-panel.ts`，统一 Plan 交互 | 消除两套发散 UX | 中 |
| 8 | 消息区增量渲染 + 流式局部更新 + 截断提示 | 长会话不卡 | 中 |
| 9 | 多根工作区支持（会话绑定根 + 选择器） | 扩大适用场景 | 中 |
| 10 | 控制器集成测试（假 runtime）+ 恢复链路 golden test | 为第 6 项兜底 | 中 |
| 11 | 编辑重发 + 对话级检查点回滚 | 补齐 Cursor 关键差距 | 大 |
| 12 | 可访问性与浅色主题体检、`l10n` 接入 | 质量与可推广性 | 中 |

第 1、2、4、5 项建议合并成一个小批次先落地，成本低但对"好不好用"的感知提升最直接；
第 6 项拆分之前最好先补第 10 项的测试。
