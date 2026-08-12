# 第七阶段 G 验收报告：三栏 Agent IDE 与可编辑 Plan

日期：2026-08-05  
范围：VS Code 扩展三栏布局、AgentWorkspaceStore 同源状态、可编辑 Plan、用量/compact、模型选择、Debug 本地编排  
约束：不 Fork Code-OSS；不重写权限/快照/Diff/持久化核心；未接入能力不伪造。

## 交付摘要

| 区域 | 实现 |
|------|------|
| 左 | Activity Bar `SessionTreeView`：固定 / 最近 / 已归档 + 搜索 + 右键 |
| 中 | 编辑器区 `AgentPanel`（WebviewPanel）；侧栏 `ChatViewProvider` 作兼容入口 |
| 右 | `secondarySidebar` 注册 Plan / Tasks / Changes / Context；检测失败时 Output 写明降级 |
| 状态 | `AgentWorkspaceStore` 细粒度分区；各视图只读订阅 |
| 模型 | `ModelRegistry` 仅 `deepseek-v4-flash`；Runtime 公开 `setModel` |
| 用量 | 精确 / 约 / 暂不可用三态；compact 仅 capability=available 时显示并真实调用 |
| Plan | `addStep` / `removeStep` / `reorderSteps` / `updateMeta` + 开始构建 / 暂停继续 |
| Debug | 本地模式（Runtime 映射 ask）；`@问题面板` 读 Diagnostics；确认后切 Agent |

## 单测

- Runtime：`72` 全绿（含 `setModel`）
- 扩展：`193` 全绿（含 Store / ModelRegistry / 用量文案 / Plan 编辑 / filterSessions / 消息伪造拒绝等）
- 合计：**265**（基线 251 + 新增）

## 手工验收对照（12 条）

1. 打开扩展后左侧可见会话树；新建 / 打开 / 固定 / 归档 / 删除可用。  
2. `lingdongAgent.openAgent` 打开中间主面板并 focus。  
3. 侧栏对话与主面板共用同一会话与消息流。  
4. 「+」菜单含模式 / 上下文 / 模型；Skills/MCP/图片显示暂未配置且禁用。  
5. 底栏显示 `{模式} · {模型} · {用量文案}`。  
6. 模型选择器仅真实模型；失败回滚。  
7. 用量三态正确；compact 不发 `/compact` 文本。  
8. Plan 可编辑并落盘；开始构建切 Agent 并发送结构化任务。  
9. Tasks / Changes / Context 与对话区同源，无第二套缓存。  
10. Debug 初始只读；确认后可改。  
11. `@问题面板` 仅工作区内诊断。  
12. 深浅色可读；无 Cursor 专有品牌资产。

## 布局降级

若宿主不接受 `viewsContainers.secondarySidebar`，`AgentController.markLayoutFallback` 写入 Store，并在「灵动 Agent」Output 通道记录原因；扩展仍可启动，右侧能力可从活动栏对话入口与命令补齐。

## 停止边界

阶段 G 完成。不开始阶段 H，不 Fork，不做安装器 / 账号体系。
