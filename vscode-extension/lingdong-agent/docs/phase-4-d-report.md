# 灵动 Agent 阶段 D 报告：模式、Plan 审批与权限系统

- 日期：2026-08-04
- 范围：`@lingdong/agent-runtime`、`vscode-extension/lingdong-agent`、`acp-poc`
- Grok Build：0.2.118（与已测试版本一致），模型 `deepseek-v4-flash`，ACP 协议版本 1
- 不在本阶段：VS Code 原生 Diff、单文件接受/拒绝、撤销本轮、`@` 上下文、会话历史与持久化、Browser 页面、三栏布局、Code-OSS Fork、安装包、账号积分、自动更新

---

## 1. Runtime 新增接口

`AgentRuntime` 不再接受构造期 `handlers`，改为「事件 + requestId 语义接口」。需要人工决定的事项一律以事件抛给宿主，宿主用 requestId 回执：

```typescript
respondPermission(requestId: string, decision: "allow_once" | "allow_session" | "reject"): Promise<void>
approvePlan(): Promise<void>                  // 回执 approved，并把本地策略模式切到 agent
rejectPlan(): Promise<void>                   // 回执 abandoned
revisePlan(feedback: string): Promise<void>   // 回执 cancelled + feedback
clearPending(reason: string): void
clearSessionRules(): void
get pendingPermissionIds(): string[]
get pendingPlanId(): string | undefined
get serverMode(): string | undefined
```

新增事件（`AgentEvent`）：

| 事件 | 载荷要点 |
| --- | --- |
| `permission_requested` | `requestId`、原始请求、`SafetyDecision`、`label`、`reason` |
| `permission_resolved` | `requestId`、`resolution`、`automatic`、`reason`、命中的会话规则 |
| `plan_review_requested` | `requestId`、结构化 `AgentPlan` |
| `plan_review_closed` | `requestId`、`approved / abandoned / cancelled / dropped` |
| `mode_changed` | `mode`、`source: "server" \| "client"` |
| `tool_started` | 增加 `kind`、`label`、`readOnly` |
| `tool_completed` | 增加可选 `exitCode` |
| `plan_updated` | 载荷由字符串改为结构化 `AgentPlan` |

新增模块：

- `src/risk-policy.ts`：`classifyCommand`、`classifyWriteTarget`、`worstRisk`、`splitCommandSegments`，输出 `low / medium / high / blocked` 与 `OperationKind`。
- `src/plan-parser.ts`：`parsePlan(raw) → AgentPlan { title, steps, files, risks, raw, empty }`，按 `#`/`##`/`###` 与编号列表解析真实中文 Markdown 计划，原文经过脱敏。
- `src/session-permissions.ts`：`SessionPermissionCache`、`deriveSessionRule`、`commandPrefix`。

`acp-poc` CLI 已同步迁移到事件订阅 + 语义接口，终端交互文案不变。

---

## 2. 四种模式的实现方式

模式有三层，互不混淆：

1. **本地策略模式**（`ask / plan / agent / auto`）：`WorkspaceSafetyPolicy` 判定的唯一依据，由扩展持有。
2. **Runtime 模式**：`AgentRuntime.mode`，与本地策略模式保持同步。
3. **服务端模式**：Grok 自己的 `plan / agent`，通过 `current_mode_update` 上报，只做展示（`serverMode`）。

`setMode` 只在 `plan / agent` 时向 Grok 发 `session/set_mode`；`ask` 与 `auto` 是纯客户端概念，从 `plan` 切出去时把 Grok 拉回 `agent`。切换在执行中被禁止，控制器会记为「待应用模式」，本轮结束后自动应用；ACP 调用失败时本地模式回滚到切换前的值并提示用户。

---

## 3. Ask 模式安全策略

- 策略层：写入与删除一律 `deny`，命令执行一律 `ask`，工作区内只读 `allow`。真实联调第 2 项验证了 Grok 尝试改 `index.html` 时被直接拒绝、工作区哈希不变。
- 输入层：`detectWriteIntent` 在发送前检测修改/创建/删除/重命名/安装/提交/执行意图。命中时**不静默切换模式**，而是拦截发送并给出「切换到 Plan / Agent / Auto」与「仍然只做分析」四个按钮；选择切换会先发 `setMode` 再继续发送原始提示词。
- 否定从句（「不要修改任何文件」「无需创建新文件」）会先被剔除，避免误拦截只读请求。

---

## 4. Plan 真实审批流程

```
Grok → _x.ai/exit_plan_mode(planContent)
     → AcpClient 登记 requestId、parsePlan
     → plan_review_requested 事件
     → AgentController 置 waiting_plan_approval，推送 Plan 卡片
     → 用户点「批准执行 / 要求修改 / 放弃计划」
     → runtime.approvePlan / revisePlan / rejectPlan
     → 回执 { outcome: approved | cancelled+feedback | abandoned }
```

卡片包含标题、编号步骤与所属文件、涉及文件清单、风险清单、状态徽标。解析不出步骤时折叠展示脱敏原文；`empty` 计划的「批准执行」按钮禁用并给出原因。

**批准后本地策略模式切到 Agent**：Grok 自身会退出 plan 模式，若仍按 `plan` 策略判定，后续写入会被硬拒绝。切换通过 `setLocalMode` 完成，不再额外发 `session/set_mode`，同时发 `mode_changed { source: "client" }` 让选择器更新。

---

## 5. Agent 权限流程

```
session/request_permission
  → WorkspaceSafetyPolicy.evaluate（工作区边界、敏感路径、风险分级、模式矩阵）
  → deny        ：立即回 reject_once，只发 permission_resolved
  → allow / 命中会话规则：立即回 allow_once，只发 permission_resolved（automatic = true）
  → ask         ：登记 requestId → permission_requested → PermissionQueue → 权限卡片
                  → 用户决定 → respondPermission → allow_once / reject_once
```

关键约束：

- **永远只回 `allow_once` 或 `reject_once`。** 即使 0.2.118 在编辑请求里提供 `allow-edits-session`（`kind: allow_always`），也绝不选择。真实联调结束后扫描 `acp-raw.log` 的 OUT 帧，`usedAllowAlways = false`。
- 卡片展示类型、目标绝对路径、命令、原因（优先取工具自带 `description`）、风险等级与队列剩余数量。
- 宿主二次校验：Runtime 判过工作区边界后，`AgentController` 用 `isInsideWorkspace` 再判一次，越界直接拒绝并提示，不进入队列。
- 权限等待超时 5 分钟（`lingdongAgent.permissionTimeoutMs`，最小 10 秒），超时自动回 `reject_once` 并把卡片置灰标记失效。
- 同一指纹连续两次被拒绝时提示改写任务描述或先用 Plan 模式确认方案。

---

## 6. Auto 模式风险规则

| 风险 | 判定示例 | Auto 行为 |
| --- | --- | --- |
| `blocked` | `sudo`、`reg`、`sc` / `Set-Service`、`format` / `diskpart`、`git push --force`、`winget/choco/msiexec`、`setx`、`.env` / `.ssh` / 私钥、工作区外路径、路径穿越、删除工作区根 | 硬拒绝（所有模式一致） |
| `high` | 删除文件、`git reset/clean/restore`、`git push`、内联脚本与脚本文件、修改环境变量、数据库结构变更、无法识别的命令 | 硬拒绝，提示切到 Agent 逐项确认 |
| `medium` | 依赖安装、`npm run dev` 等长期服务、`git commit/add/merge`、网络请求、构建、`npx`、修改 `package.json` 等清单文件 | 工作区内文件变更自动放行，其余询问 |
| `low` | `git status/diff/log`、`npm test`、lint、`tsc --noEmit`、格式化、工作区内读取与普通源文件写入 | 自动放行 |

链式命令按 `&&`、`||`、`;`、`|`、换行逐段判定后取最严重的一段；`CI=1 sudo npm test` 这类前缀伪装会先剥离环境变量赋值再判定。无法归类一律 `high`，只有工具自报 `read_only: true` 或确无写入迹象的操作才可能落到 `low`。

---

## 7. 权限队列

`PermissionQueue`（不依赖 vscode，可单测）：

- 任何时刻只暴露一个 `current`，其余排队，卡片上显示「队列中还有 N 个请求等待处理」。
- `enqueue` 拒绝空、重复与已处理过的 requestId，队列上限 50。
- `resolve(requestId)` 只接受当前卡片，伪造或过期的 requestId 返回 `undefined`。
- `expire(requestId)` 可移除队列中任意位置的卡片（超时场景）。
- `clear()` 返回全部被丢弃的卡片并标记为已处理；已处理集合上限 500，FIFO 淘汰。
- 取消任务、新建会话、重新连接、本轮结束都会 `clear()`，同时调用 `runtime.clearPending()` 让 Runtime 对 Grok 回执 `cancelled`。

---

## 8. 会话权限缓存

「本次会话允许」完全由本地实现，只存在于扩展进程内存，不落盘、不使用 Grok 的持久化选项。规则是**范围规则**而不是精确指纹：

| 规则 | 取值 | 匹配方式 |
| --- | --- | --- |
| `workspace-write` | 工作区根 | 写入操作且所有目标都在工作区内 |
| `command-prefix` | 命令前两个非选项 token（如 `npm test`） | 单段命令且前缀一致；链式命令永不复用 |
| `read-path` | 目标所在目录 | 读取操作且所有目标都在该目录下 |

`high` 与 `blocked` 永不缓存也永不命中；工作区外操作永不命中。会话结束（新建会话、`session/load`、重新连接、关闭）即清空。真实联调第 6 项在新会话中重新弹出确认，验证了清空生效。

---

## 9. UI 状态机

状态：`idle → initializing → ready → sending → streaming → waiting_permission / waiting_plan_approval → cancelling → completed → ready`，另有 `error` 与 `disposed`。非法迁移被忽略且不改变状态。

守卫：`canSend`、`canCancel`、`canSwitchMode`、`canApprovePlan`、`canRespondPermission`。**所有来自 Webview 的动作在调用 Runtime 前都要重新过守卫**，Webview 的按钮禁用只是提示，不作为安全依据；例如 `waiting_permission` 之外收到 `permissionDecision` 会被直接丢弃并记日志。

Webview 侧新增：模式选择器（禁用态带原因 tooltip、显示 Grok 服务端模式与待应用模式）、Plan 卡片、权限卡片、可折叠工具卡片（读取/修改/命令/搜索/计划五类，含状态徽标、退出码与输出折叠区）、Ask 意图提示卡片、错误态与「重新连接」按钮。全部只使用 `--vscode-*` 变量，深浅色主题通用；DOM 全部由 `createElement` + `textContent` 构造，没有任何 `innerHTML`。

---

## 10. 测试结果

| 套件 | 数量 | 结果 |
| --- | --- | --- |
| `@lingdong/agent-runtime` | 49 | 全部通过 |
| `lingdong-agent`（扩展） | 40 | 全部通过 |
| 合计 | 89 | 全部通过 |

Runtime 新增：`risk-policy.test.ts`（8）、`plan-parser.test.ts`（5）、`session-permissions.test.ts`（5）、`permission-flow.test.ts`（7）、`plan-flow.test.ts`（5）。扩展新增：`permission-queue.test.ts`（5）、`ui-state.test.ts`（6）、`ask-intent.test.ts`（5）、`plan-view-model.test.ts`（4），并扩充 `messages.test.ts`（+5）。

`tests/fixtures/fake-grok.mjs` 现在可按提示词关键字发起真实形态的反向请求：编辑权限（带 `allow_always` 选项，用于验证我们从不选它）、命令权限、双权限排队、正常计划与空计划，从而在无真实模型的情况下覆盖完整回环。

既有 19 项 Runtime 测试与 15 项扩展测试全部保留。`acp-client.test.ts` 只删除了已不存在的 `handlers` 构造参数；`event-presenter.test.ts` 的两项按新事件形态适配，断言意图不变（权限只展示已做出的决定、工具事件仍可读）。

---

## 11. 八项真实联调结果

命令：`npm run check:phase4 --workspace lingdong-agent`（真实 Grok 0.2.118 + DeepSeek，无头运行，脚本退出码 0）

| # | 场景 | 模式 | 结果 |
| --- | --- | --- | --- |
| 1 | Ask 只读分析 | ask | `end_turn`，只调用 List Files / Read，工作区未变 |
| 2 | Ask 拒绝修改 | ask | Grok 发起 Edit，策略自动 `reject_once`，`cancelled`，工作区未变 |
| 3 | Plan 放弃计划 | plan | 收到 4 步计划（涉及 3 个文件），回执 `abandoned`，工作区未变 |
| 4 | Plan 批准并执行 | plan → agent | 收到 3 步计划，回执 `approved`，本地策略转 Agent，随后弹出 README.md 写入确认并允许，文件已改 |
| 5 | Agent 允许修改 | agent | 弹出 index.html 写入确认（low），允许一次后文件已改 |
| 6 | Agent 拒绝修改 | agent | 新会话中重新弹出 style.css 写入确认，拒绝后 `cancelled`，工作区未变 |
| 7 | Auto 低风险自动执行 | auto | 只读操作自动放行，无确认卡片，工作区未变 |
| 8 | 停止任务 | agent | 1.5 秒后取消，`stopReason = cancelled`，工作区未变 |

全局校验：`workspaceRestored = true`（脚本结束时把 `workspace/grok-test` 还原为初始内容并删除新增文件）、`usedAllowAlways = false`（扫描 OUT 帧确认从未选择 `allow-edits-session` / `allow_always`）、`shutdown.running = false`、`grokTested = true`。

一次中间运行还验证了会话规则：第 5 项第二次确认选「本次会话允许」后，同会话内后续工作区写入被自动放行（`permission_resolved.automatic = true`，命中 `workspace-write` 规则）；正式运行把第 6 项放到新会话，因而重新弹出确认，反过来证明了会话结束即清空。

UI 层交互（卡片按钮、折叠、主题）仍需在 Extension Development Host 中人工确认，与阶段 C 一致。

---

## 12. 已知问题

1. **模型行为不稳定影响计划触发**：同一会话中刚被否掉一次计划后，Grok 往往直接用文本回答而不再调用 `_x.ai/exit_plan_mode`。联调脚本因此在计划批准场景使用新会话；产品上表现为「要求修改」后不一定还能拿到结构化计划卡片。
2. **Grok 有时会用 Ask User 工具反问**而不是直接执行，此时本轮以 `end_turn` 结束且没有权限请求，UI 上只看到一段提问文本。
3. **命令风险分类基于正则**，对罕见 shell 写法（复杂管道、嵌套引号、别名）会落到「无法识别 → high」，Auto 模式下表现为硬拒绝，需要用户切到 Agent 手动确认。
4. **权限超时依赖扩展进程计时器**，若 Extension Host 被挂起，超时判定会延后；Runtime 侧不会自行超时。
5. **计划状态未持久化**，面板重新挂载后只能恢复当前权限卡片与状态快照，历史计划卡片不会重建。
6. `plan_updated`（Grok 的待办列表）与 `plan_review_requested`（真正的审批计划）都渲染成 Plan 卡片，长任务里可能出现多张卡片，只有 `ready` 状态那张带审批按钮。

---

## 13. 下一阶段建议

1. 接入 VS Code 原生 Diff：把 `file_changed` 与 tool diff 内容落到 `TextDocumentContentProvider`，支持单文件接受/拒绝与撤销本轮。
2. 会话历史与持久化：记录轮次、计划、权限决定，支持 `session/load` 恢复面板内容。
3. `@` 上下文选择器：文件、选区、符号，配合 Extension Host 侧的工作区校验。
4. 把风险分类从正则升级为「命令解析 + 白名单」，并允许用户在设置里维护自己的低风险命令前缀。
5. 补一个 Extension Development Host 的手动验收清单（卡片交互、主题、键盘操作），把目前口头确认的部分固化下来。

---

## 14. 修改文件清单

**`packages/agent-runtime`**

- 新增：`src/risk-policy.ts`、`src/plan-parser.ts`、`src/session-permissions.ts`
- 修改：`src/safety-policy.ts`、`src/acp-client.ts`、`src/agent-runtime.ts`、`src/event-normalizer.ts`、`src/index.ts`、`package.json`
- 测试：新增 `tests/risk-policy.test.ts`、`tests/plan-parser.test.ts`、`tests/session-permissions.test.ts`、`tests/permission-flow.test.ts`、`tests/plan-flow.test.ts`；修改 `tests/acp-client.test.ts`、`tests/fixtures/fake-grok.mjs`

**`acp-poc`**

- 修改：`src/index.ts`、`tests/live-smoke.ts`、`tests/live-cancel-load.ts`

**`vscode-extension/lingdong-agent`**

- 新增：`src/permission-queue.ts`、`src/ui-state.ts`、`src/ask-intent.ts`、`src/plan-view-model.ts`、`scripts/live-phase4-check.mjs`、`docs/phase-4-d-report.md`
- 修改：`src/messages.ts`、`src/event-presenter.ts`、`src/agent-controller.ts`、`src/chat-view-provider.ts`、`src/extension.ts`、`src/webview/main.ts`、`src/webview/main.css`、`package.json`
- 测试：新增 `tests/permission-queue.test.ts`、`tests/ui-state.test.ts`、`tests/ask-intent.test.ts`、`tests/plan-view-model.test.ts`；修改 `tests/messages.test.ts`、`tests/event-presenter.test.ts`

新增配置项：`lingdongAgent.permissionTimeoutMs`（默认 300000，最小 10000）。
新增命令：`lingdongAgent.reconnect`、`lingdongAgent.approvePlan`、`lingdongAgent.rejectPlan`。
新增脚本：`npm run check:phase4 --workspace lingdong-agent`。
