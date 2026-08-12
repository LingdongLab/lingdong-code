# 阶段 G-R2.3：Cursor 式 Plan 工作流重构报告

日期：2026-08-05  
状态：**已完成**  
边界：禁止阶段 H；禁止 Fork Code-OSS；未改 Runtime / Diff / SnapshotStore / 权限队列核心

---

## 1. 问题与结果

| 原问题 | 处理 |
|--------|------|
| 通用 input/textarea 表单 | 拆成 Plan 专用文档/编辑组件 |
| 分析结果与步骤混在一起 | ViewModel 过滤 `Get-ChildItem` 等噪声步骤 |
| 空字段 + 孤立删除按钮 | 阅读态无输入框；空章节紧凑文案 |
| 绝对路径暴露 | `toUiRelativePath` / 保存时过滤盘符路径 |
| 阅读/编辑未分离 | 默认阅读态；仅「修改计划」进编辑态 |
| Plan 模式 Get-ChildItem 被拒中断 | 提示词注入研究约束 + 宿主文件概览 |
| 空白 chip 胶囊 | 无上下文时隐藏 `.chips` |

---

## 2. ViewModel

[`src/webview/plan/plan-view-model.ts`](../src/webview/plan/plan-view-model.ts)

- `PlanDocumentViewModel`：id / version / status / title / goal / clarifications / files / risks / steps / progress / timestamps
- `PlanStepViewModel`：id / order / title / description / files / status / validation?
- 状态文案：待开始 / 执行中 / 已完成 / 失败 / 已跳过
- 禁止把绝对路径与文件分析噪声当作步骤

---

## 3. 组件拆分

`src/webview/plan/`：

| 文件 | 职责 |
|------|------|
| `plan-document-view.ts` | 阅读态文档 |
| `plan-editor-view.ts` | 编辑态 |
| `plan-step-list.ts` | 阅读步骤 |
| `plan-step-editor.ts` | 独立步骤编辑 + 上移/下移/拖拽 |
| `plan-file-chips.ts` | 相对路径 chip |
| `plan-clarifications.ts` | 澄清事项 |
| `plan-risk-section.ts` | 风险 |
| `plan-action-bar.ts` | 统一 Action Bar |
| `plan-right-rail.ts` | 右侧精简 Plan |
| `plan.css` | 文档视觉（深色基准 / 浅色卡片） |

`main.ts` 仅：接收 Store → 构建 ViewModel → 切换阅读/编辑 → 派发消息。

---

## 4. 交互

### 阅读态（默认）

标题栏：标题 / 状态 / 版本 / 更新时间  
正文：目标、澄清、涉及文件、风险、步骤  
空风险：「暂未发现明显风险。」  
空澄清：「当前没有待确认事项。」  
底部 Action Bar：继续研究 / 修改计划 / 保存计划 / 放弃 / **开始构建** / 在右侧打开计划

### 编辑态

仅点「修改计划」进入。每步独立组件；上移/下移 + 拖拽；文件 chip 增删；保存后回阅读态。

### 右侧 Workbench

默认不显示 Plan。用户点「在右侧打开计划」后仅：标题、进度、步骤状态、开始构建、保存。无完整表单。

### Composer

无上下文时 `#context-items` `hidden` + `.chips-empty`，不渲染空白胶囊。

---

## 5. Plan 研究流程

新增 [`src/plan-research.ts`](../src/plan-research.ts)：

- Plan 模式 `sendPrompt` 注入研究约束
- 宿主 `findFiles` 生成相对路径文件概览，减少模型去跑 `Get-ChildItem`
- 明确禁止默认使用 `Get-ChildItem` / `dir` / `ls`
- Runtime 既有策略：Plan 模式 deny write/execute（未改核心，测试复用验证）

「开始构建」仍走既有 `startPlanBuild` → `setMode("agent")`。

---

## 6. 验证

```text
npm run typecheck  # 通过
npm test           # 235 pass（含 plan-document-ui 14 项）
npm run build      # 通过
```

覆盖要点：默认阅读态无 textarea、编辑态独立步骤、增删/上移下移/拖拽属性、文件 chip、绝对路径不出 UI、空章节紧凑、右侧精简、Plan 禁 shell 列目录、无空 chip、Markdown 与 PlanRecord 折叠去重（既有 message-renderer）。

---

## 7. 未做（边界）

- 未开始阶段 H
- 未 Fork Code-OSS
- 未改 Runtime / Diff / SnapshotStore / 权限队列核心
- secondarySidebar `plan-panel` 仍为兼容备份；产品主路径为 AgentPanel 中间 Plan 文档
