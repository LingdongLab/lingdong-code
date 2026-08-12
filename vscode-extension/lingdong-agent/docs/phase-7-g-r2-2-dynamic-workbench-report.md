# 阶段 G-R2.2：右侧 Dynamic Workbench 重构报告

日期：2026-08-05  
状态：**已完成**  
边界：禁止阶段 H；禁止 Fork Code-OSS；布局偏好仅存 Webview `getState`/`setState`，不污染 `AgentWorkspaceStore`

---

## 1. 目标与结果

将右侧固定 Inspector（永久 Plan / Tasks / Changes / Context）改造为 **Dynamic Workbench**：

| 能力 | 结果 |
|------|------|
| 可选 / 可关闭 | 默认收起；关闭后本会话 `suppressAutoOpen`，不再强制抢开 |
| 可调宽 | 拖动手柄；最小 280px，最大窗口宽 50% |
| 可切换工具 | 动态标签条；标签可单独关闭 |
| 可保存打开状态 | `WorkbenchState` 写入 `vscode.setState` |
| 不遮挡 Composer | `<1200px` 覆盖式抽屉 `bottom: var(--composer-h)` |

---

## 2. 工具矩阵

| 工具 | 状态 | 实现 |
|------|------|------|
| Changes | 启用 | 复用 ChangeTracker：Diff / 接受 / 拒绝 / 全部 / 撤销 |
| Files | 启用 | 宿主 `listWorkspaceFiles` / `openWorkspaceFile`（仅相对路径） |
| Tasks | 启用 | 真实任务状态；不根据普通模型文字伪造完成 |
| Context | 启用 | 完整管理仅在主动打开时；Composer 有 chips + 用量浮层 |
| Browser | 启用（宿主） | `simpleBrowser.show`，失败则外链；Webview 不伪造浏览器 |
| Terminal | 启用（宿主） | `workbench.action.terminal.new`；Webview 不模拟终端 |
| Plan | 按需 | 中间 Plan 文档为主；「在右侧打开计划」才进 Workbench |
| Preview | **禁用** | `TOOL_META.preview.enabled = false`，文案「暂未配置」 |

---

## 3. 状态结构

新增 [`src/webview/workbench-state.ts`](../src/webview/workbench-state.ts)：

```ts
WorkbenchState {
  collapsed, width, activeTool, openTools,
  userPinned, lastActiveTool, suppressAutoOpen
}
```

工具类型：`changes | files | tasks | context | browser | terminal | preview | plan`

布局偏好：`LayoutState = { leftCollapsed?, leftPinned?, workbench? }` → 仅 Webview state。

---

## 4. 交互调整

### 左侧入口

Changes / Files / Browser / Terminal → 打开或激活右侧对应工具。

### Plan

- 中间卡片为权威阅读/编辑面
- 右侧不再永久 Tab
- 「在右侧打开计划」→ `openWorkbenchTool("plan")`

### Context

- Composer：chips + 用量 chip
- 点击用量 → 紧凑浮层（用量 / 项数 /「在右侧管理」）
- 完整清空 / compact 在右侧 Context 工具

### 响应式

- 默认右侧收起
- 用户选工具后展开
- 手动关闭后本会话不自动强制打开（`suppressAutoOpen`）
- `<1200px`：`.wb-drawer` 覆盖式，不遮挡 Composer

---

## 5. 协议与宿主

Webview → Host：

- `listWorkspaceFiles` / `openWorkspaceFile`
- `openNativeTerminal` / `openSimpleBrowser`

Host → Webview：`workspaceFiles`

路径守卫：拒绝 `..`、绝对盘符、工作区外路径；Files 列表只返回相对路径。

---

## 6. 主要改动文件

| 文件 | 说明 |
|------|------|
| `src/webview/workbench-state.ts` | 纯 UI 工作台状态 |
| `src/webview/main.ts` | 动态标签、拖宽、左栏入口、用量浮层 |
| `src/webview/main.css` | workbench / drawer / left-tools / usage-popover |
| `src/agent-panel.ts` | 右栏 HTML 壳与左栏工具按钮 |
| `src/messages.ts` / `webview-message-handler.ts` / `agent-controller.ts` | 文件/终端/浏览器消息 |
| `tests/workbench-state.test.ts` | 状态机单测 |

---

## 7. 验证

```text
npm run typecheck  # 通过
npm test           # 221 pass（含 workbench-state / 工作台消息白名单）
npm run build      # 通过
```

---

## 8. 未做（本阶段边界）

- 未开始阶段 H
- 未 Fork Code-OSS
- Preview / 假浏览器 / 假终端均未嵌入
- secondarySidebar 四视图仍可作为兼容备份入口；产品主路径为 AgentPanel Dynamic Workbench

---

## 9. 人工验收清单

1. 默认右侧收起  
2. 左侧 Changes / Files / Browser / Terminal 可打开右侧  
3. 标签可切换、可单独关闭、可整栏关闭  
4. 关闭后变更到来不强制再开  
5. 拖宽受 280px～50% 约束  
6. Files 点击由宿主打开文件  
7. Browser / Terminal 走 VS Code 原生命令  
8. Plan 仅「在右侧打开计划」时出现在右栏  
9. 用量点击出浮层，不强制打开 Context  
10. `<1200px` 抽屉不挡住 Composer  
