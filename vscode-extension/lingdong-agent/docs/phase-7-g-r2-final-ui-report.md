# 阶段 G-R2：最终产品 UI 实装报告

日期：2026-08-05  
状态：**已完成产品 UI 实装**（复用现有 Runtime / Store / 权限 / Diff / 会话存储）  
边界：禁止阶段 H；禁止 Fork Code-OSS；禁止另起视觉探索

---

## 1. 布局决策

主产品界面为 **AgentPanel 单 Webview 三栏壳**：

| 栏 | 宽度 | 职责 |
|----|------|------|
| 左 | 256px | 品牌、工作区、搜索、新建、固定/最近/归档、设置/日志 |
| 中 | 弹性 · 阅读宽 920px / Plan 1040px | 唯一对话、工具摘要、Plan、权限、变更摘要、Composer |
| 右 | 348px | 固定 Tab：Plan / Tasks / Changes / Context；可折叠 |

Ask 模式默认建议收起右栏；Plan / 变更 / 上下文活动时建议展开，但不抢焦点（`rightPinned` 记忆用户手动选择）。

### 兼容降级

- Activity Bar「打开面板」：[`ChatViewProvider`](../src/chat-view-provider.ts) 仅启动器，**不再渲染完整对话**。
- SessionTree：保留为 VS Code 原生备份入口；主路径为 Webview 左侧列表（同源 `SessionRepository` / Store）。
- secondarySidebar 四视图：仍推送同源状态，产品操作以主面板右栏为准。

---

## 2. 视觉规范落地

[`src/webview/main.css`](../src/webview/main.css) 采用需求给定 Linear 式令牌：

- 深色：`#0B0F14` / `#0D1218` / `#0F141A` / `#131920`，品牌 `#21C7B7`
- 浅色：中性灰 `#F5F6F7` / `#EFF1F3` / `#FAFAFA`，品牌 `#078D82`（非米黄）
- 品牌色仅用于选中、主按钮、进度、少量状态
- 阴影仅浮层 / 模型选择器 / 权限卡
- 响应式：`<1200px` 右栏可自动收；`<1000px` 左栏可收

---

## 3. 复用清单（未重写）

| 模块 | 用途 |
|------|------|
| `AgentWorkspaceStore` | 三栏同源状态 |
| `SessionRepository` / `SessionPersistence` | 会话列表与恢复 |
| `PlanRepository` | Plan 读/编/构建 |
| `ChangeTracker` + `SnapshotStore` + `vscode.diff` | Changes / Diff / 接受拒绝撤销 |
| `ContextUsageService` + `formatUsageLabel` | 精确 / 约 / 暂不可用 |
| `PermissionQueue`（阶段 D） | 权限确认 |
| `AgentRuntime` / ACP | 执行与工具事件 |
| `ModelRegistry` | 仅真实可用模型 |

新增展示层：`src/webview/tool-aggregate.ts`（工具轮次聚合与中文动词）。

---

## 4. 交互要点

1. **工具摘要**：默认折叠标题 + 中文统计；展开才见文件明细；3 秒内相同文案去重；Read→已读取 等。
2. **Composer**：chips + 96～220px 自增高输入；`+` 分组菜单；模式/模型/用量；停止/发送。未实现项（Multitask、图片、Skills、MCP、扩展商店、自定义模型）禁用并标「暂未配置」。
3. **Plan**：默认文档阅读态；「修改计划」进入编辑态；中右同一 `PlanRecord`。
4. **Changes**：中间仅摘要 +「查看变更」；完整 Diff/接受/拒绝仅右侧。
5. **权限**：克制危险边框；命令独立代码块；高风险禁用「本次会话允许」。
6. **噪声过滤**：sessionId / ACP / 绝对路径 / JSON 原文等不进对话区（`event-presenter.statusTarget` + Webview notice 过滤）。

新增消息：`pinSession` / `archiveSession` / `searchSessions` / `openSettings` / 宿主 `sessions` 推送。

---

## 5. 测试

```text
npm run typecheck  # 通过
npm test           # 199 pass（含 tool-aggregate / 会话消息白名单 / statusTarget 噪声）
npm run build      # 通过
```

---

## 6. 未启用能力（诚实禁用）

- Multitask 模式  
- 图片上下文  
- Skills / MCP / 扩展商店  
- 模型 Auto（仅单模型时不可用）  
- 添加自定义模型  

---

## 7. 人工验收清单（请本地确认）

1. 左侧会话切换正常  
2. 中间只有一套 Agent 对话  
3. 右侧 Tab 可切换与收起  
4. 工具事件默认聚合  
5. Plan 阅读态 / 编辑态  
6. 开始构建真实执行  
7. Changes 打开 VS Code Diff  
8. 接受 / 拒绝 / 撤销  
9. 权限不泄露内部路径  
10. 上下文精确 / 估算 / 不可用三态  
11. Compact 调用 Runtime 接口  
12. 深色 / 浅色可读  
13. 1920 / 1600 / 1366 可操作  
14. 重启后会话 / Plan / Changes 恢复  
15. 现有测试继续通过  

---

## 8. 停止边界

- **不**开始阶段 H  
- **不** Fork Code-OSS  
- **不**再自由设计另一套视觉  

交付入口：命令「灵动 Agent: 打开 Agent 主面板」或侧栏「打开面板」。
