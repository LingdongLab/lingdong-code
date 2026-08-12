# 中间对话区与 Turn 状态收口报告

日期：2026-08-08  
范围：只改中间聊天 + Turn 状态；右侧面板 / Provider / Runtime / 仓库 / 安装包未动。  
验证：`npm run typecheck`、`npm test`、`npm run build` 通过；**未**执行 `packaging/build-installer.ps1`。

---

## Turn 主状态

唯一状态机：`src/services/turn-status-machine.ts`（展示名 `TurnMainStatus`，避免与 Timeline `TurnStatus` 冲突）。

状态：`idle | preparing | thinking | working | waiting_for_user | stopping | completed | failed | stopped | interrupted`

合法转换与文档 §2.2 一致；非法转换开发态抛错、生产记日志并忽略。

边界：

- `waiting_for_user` 可停 → `stopping` → 清挂起卡 → `stopped`
- 权限超时（`expired`）→ 回 `working`（非 `failed`）
- preparing 失败：连接类 → `interrupted`；Provider/模型/凭据类 → `failed`
- `interrupted` 终态不复活；重连只恢复可发送
- Runtime 直接报 `cancelled` 时补 `stopping → stopped`

驱动点：`TurnService`（发送 / 事件 / 停止）；Webview 不得改主状态。

---

## 中间对话与唯一 Status Bar

- Composer **上方**新增 Turn Status Bar（`turn-status-bar.ts`）
- 去掉 thinking 条、`activity` 驱动的全局「处理中」、Composer 行内 running 观感
- 宿主推送 `turnStatus`；Stop 按钮认 `canStop` / `turnActive`

---

## Timeline 去重与紧凑

- Agent 模式注入 `AGENT_REPLY_GUIDANCE`（`plan-research.ts`）：正文不复述工具过程；前端不改模型正文
- Plan 中间区继续用现有 `collapseDuplicatePlanMarkdown`；右侧 Plan 不动
- Timeline group **默认折叠**；摘要行保留当前动作；底层工具名需展开才见

---

## Composer / Context

- 运行态只在 Status Bar；`[+]` / 模式 / 模型 / 发送|停止 一行保持简单
- Context 不可用：隐藏芯片与「暂不可用」文案
- 可用：`Context N%`；满：`上下文已满 · 压缩`

---

## Stop / Waiting / Completed

- 点停立刻 `stopping`，按钮 disabled；`stopped` 后丢弃 delta / 普通 Timeline
- Waiting：状态栏「等待你的确认」；`activeElapsed` 暂停
- Completed：轻量摘要（文件数 ← ChangeTracker；测试 ← 单一 `/(\d+)\s+passed/i`）；可选「查看 Changes」

---

## 错误分派

| 类别 | 位置 |
|---|---|
| 连接类 | 仅 Status Bar（`interrupted` + 重连/重试） |
| Provider/模型类 | 仅聊天区错误卡（`failed`） |
| 工具失败 | 仅 Timeline item |

---

## 流式与滚动

- 合帧间隔 60ms（`STREAM_PAINT_INTERVAL_MS`）；可测 `onPaint` 钩子
- 上滚停跟；按钮文案「↓ 回到最新消息」

三条可测标准（`tests/stream-scroll-contract.test.ts`）：均通过

1. 流式期间历史 message DOM identity 不变  
2. 单窗口 20 个 delta，paint ≤ 2  
3. Timeline 更新不触发 conversation 容器 mutation  

---

## 气泡 / 排版

- 用户气泡：`width: fit-content; max-width: 70%`，padding 收紧
- Agent 正文：`line-height: 1.7`，避免无意义横向滚动

---

## 测试结果

- `npm run typecheck`：通过  
- `npm test`：894 通过 / 0 失败  
- `npm run build`：通过  
- 新增/扩展：`turn-status-machine`、`turn-status-bar`、`completed-summary`、`stream-scroll-contract`、`agent-reply-guidance` 等

---

## 主要修改文件

- `src/services/turn-status-machine.ts`（新）
- `src/services/completed-summary.ts`（新）
- `src/services/turn-service.ts`
- `src/plan-research.ts`
- `src/messages.ts`
- `src/usage-format.ts`
- `src/agent-panel.ts`
- `src/webview/turn-status-bar.ts`（新）
- `src/webview/message-router.ts` / `main.ts` / `composer.ts` / `conversation.ts`
- `src/webview/message-renderer.ts` / `main.css` / `message-markdown.css`
- `src/webview/timeline/activity-group-view.ts`
- `tests/*`（上列新测 + 回归调整）
- `package.json`（注册新测试）

本轮**未**重打安装包。
