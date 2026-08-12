# 阶段 G-R1：Agent IDE 产品界面静态原型报告

日期：2026-08-05  
状态：**仅静态高保真原型**，未接入 Runtime / AgentWorkspaceStore  
边界：禁止阶段 H；禁止 Fork；禁止继续堆功能；等待人工确认后再做真实 UI 接线

---

## 1. 交付物

目录：[`vscode-extension/lingdong-agent/ui-prototype/`](../ui-prototype/)

| 文件 | 用途 |
|------|------|
| `index.html` | 原型索引 |
| `styles.css` | 共用设计令牌（深/浅色、间距、圆角、阅读宽度） |
| `agent-dark.html` | 深色：对话 + 工具折叠 + 权限确认 + 用量 warning + Composer「+」菜单 |
| `agent-light.html` | 浅色：普通 Ask 对话 |
| `plan-dark.html` | 深色：产品化 Plan 编辑器 + 右侧 Plan Tab |
| `changes-dark.html` | 深色：工具执行中 + 变更摘要 + 右侧 Changes Tab |
| `serve.mjs` | 本地预览服务器（可选） |
| `screenshots/` | 人工预览截图 |

### 本地预览

```bash
node vscode-extension/lingdong-agent/ui-prototype/serve.mjs
# 打开 http://127.0.0.1:8765/
```

也可直接用浏览器打开各 HTML（同目录下 `styles.css` 需可访问）。

---

## 2. 设计决策（对照验收问题）

| 问题 | 原型对策 |
|------|----------|
| 左/中双聊天重复 | 左侧只保留 SessionTree +「打开面板」；中间为唯一对话入口 |
| 右侧四视图堆叠 | 右侧顶部 4 Tab，同时只显示一个面板 |
| 工具事件噪声 | 按轮次聚合为可折叠摘要；展开才见明细 |
| 开发日志污染对话 | 对话仅保留用户可读 notice；不出现 JSON/sessionId/ACP/内部路径 |
| Plan 内部工具外泄 | Plan 卡片只展示标题/目标/澄清/步骤/文件/风险/版本与产品操作 |
| 输入区未统一 | Composer：上下文 chips + 多行输入 +「+」分组菜单 + 模式/模型/用量 + 发送 |
| 状态冲突 | 顶栏与底栏统一为 `{模式} · {模型} · {用量}`；无 Grok/ACP 文案 |
| 会话树空旷难读 | 固定/最近/归档；空组折叠；标题省略 + tooltip；副信息一行 |
| 调试面板观感 | 石墨黑 / 暖灰白 + 东方青强调；居中阅读宽度约 920px |

---

## 3. 场景覆盖与截图

截图目录：`ui-prototype/screenshots/`

| # | 场景 | 对应文件 | 截图 |
|---|------|----------|------|
| 1 | 普通 Agent 对话 | `agent-dark.html` / `agent-light.html` | `agent-dark.png` / `agent-light.png` |
| 2 | 工具执行中 | `changes-dark.html`（进行中摘要） | `changes-dark.png` |
| 3 | Plan 编辑 | `plan-dark.html` | `plan-dark.png` |
| 4 | 文件变更审查 | `changes-dark.html` 右侧 Changes | `changes-dark.png` |
| 5 | 权限确认 | `agent-dark.html` | `permission-dark.png` |
| 6 | 上下文用量 warning | `agent-dark.html` 顶栏 + Context Tab | `agent-dark.png` / `permission-dark.png` |
| 7 | 深色主题 | 上述 dark 页面 | 同上 |
| 8 | 浅色主题 | `agent-light.html` | `agent-light.png` |

---

## 4. 布局规格（原型）

- 左栏约 `240px`：品牌、新建、打开面板、搜索、会话分组  
- 中栏：唯一 Agent 工作区；正文 `max-width: 920px` 居中  
- 右栏约 `328px`：Plan / Tasks / Changes / Context 单选 Tab  
- Composer 默认高度约 `110px`；「+」菜单含模式 / 上下文 / 扩展能力（未配置禁用）

---

## 5. 明确未做（待确认后）

- 未修改扩展 `src/` 中的 Runtime、权限、Diff、会话持久化逻辑  
- 未接入 `AgentWorkspaceStore`  
- 未改侧栏真实 ChatView / AgentPanel 实现  
- 未开始阶段 H  

---

## 6. 请人工确认的问题

请对照截图确认：

1. 三栏密度与左右宽度是否合适？  
2. 工具聚合摘要的信息量是否够用？  
3. Plan 产品化字段与按钮文案是否完整？  
4. Composer「+」菜单分组是否符合预期？  
5. 深色 / 浅色气质是否可接受（东方青强调、非纯蓝大按钮）？  

**确认通过后**，再进入真实 UI 接线（仍不开始 H）。  
**本轮到此停止。**
