# 阶段 G-R2.1：Markdown 渲染与对话层级修复报告

日期：2026-08-05  
状态：**已完成**  
边界：禁止阶段 H；禁止 Fork Code-OSS；本轮未改配色与品牌视觉

---

## 1. 问题与对策

| 验收问题 | 对策 |
|----------|------|
| Markdown 当纯文本 | `markdown-it` → `DOMPurify` → DOM；原始文存 `rawMarkdown` |
| 暴露 ## / ** / 围栏 | 正式渲染标题、粗体、代码块、表格等 |
| 层级不清 | 用户块 / 灵动 Agent 标识 + `.md-body` / ToolSummary / PlanView / PermissionCard 分离 |
| 内部工具名外泄 | `productizeToolLabel`；详情才见 raw |
| Plan 双开 | `looksLikePlanOutline` + 折叠为「查看计划」；状态仅 PlanRecord |
| 正文过宽 | `--read-max: 920px`，助手行高 1.7 |
| 左栏/右栏文字按钮 | 改为图标按钮 + tooltip |

---

## 2. 新增与关键改动

| 文件 | 说明 |
|------|------|
| [`src/webview/message-renderer.ts`](../src/webview/message-renderer.ts) | 安全渲染、流式 debounce、噪声过滤、工具中文化、Plan 折叠 |
| [`src/webview/message-markdown.css`](../src/webview/message-markdown.css) | Markdown / 代码块 / 表格滚动 / 助手层级 |
| [`src/webview/tool-aggregate.ts`](../src/webview/tool-aggregate.ts) | 按 `toolCallId + action + path` 聚合；不同文件不误去重 |
| [`src/webview/main.ts`](../src/webview/main.ts) | 流式只更新当前消息；恢复时整段 mount；Plan 去重 |
| [`src/agent-panel.ts`](../src/agent-panel.ts) | 布局切换图标按钮 |
| [`src/messages.ts`](../src/messages.ts) + Controller | `openExternalUrl` 宿主打开外链 |
| 依赖 | `markdown-it`、`dompurify`（dev：`jsdom` 等） |

### 渲染链路

```text
rawMarkdown → markdown-it → DOMPurify(allowlist) → .md-body
```

禁止业务路径直接 `innerHTML = modelText` 或仅用 `textContent` 展示助手正文。

### 流式

- 仅更新当前 `StreamRenderHandle`
- debounce 80ms
- 历史消息不重建
- `assistantEnd` 后 `finalize()` 完整渲染
- 接近底部才跟随滚动

---

## 3. 安全策略

- 禁止 script / iframe / 内联事件 / `javascript:` URL
- 外链 `preventDefault` + `openExternalUrl` → `vscode.env.openExternal`
- 单测覆盖注入与 javascript URL

---

## 4. 测试

```text
npm run typecheck  # 通过
npm test           # 214 pass
npm run build      # 通过
```

覆盖：标题/粗体/代码/表格/列表与任务列表、XSS、流式、历史不重复、Plan 折叠、工具中文化、不同文件不误去重、外链白名单等。

---

## 5. 停止边界

- **不**开始阶段 H  
- **不** Fork Code-OSS  
- **不**本轮继续改配色与品牌视觉  

请重新打开 Agent 主面板做人工验收（Markdown、工具摘要、Plan 去重、920px 阅读宽）。
