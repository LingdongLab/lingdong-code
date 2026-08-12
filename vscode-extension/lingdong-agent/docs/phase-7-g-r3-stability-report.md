# 阶段 G-R3：稳定性与基础操作手感

完成时间：2026-08-05
范围：`vscode-extension/lingdong-agent` + `packages/agent-runtime`

验证结果：

| 项目 | 结果 |
| --- | --- |
| `npm run typecheck`（扩展） | 通过 |
| `npm run typecheck`（Runtime） | 通过 |
| `npm test`（扩展） | 256/256 通过（原 235，新增 21） |
| `npm test`（Runtime） | 75/75 通过（原 72，新增 3） |
| `npm run build` | 通过 |

---

## 一、Grok 异常退出自动失效与重连

### 问题

Runtime 层在 `acp-client.ts` 检测到子进程非预期退出后会 `failAll`，但扩展层的
`ensureStarted()` 把 `this.startup` 永久缓存，只有手动重连或扩展销毁才会清。
`connection: "failed"` 也只在发送失败与重连失败两处发出。
结果是 Grok 崩溃后界面仍显示「就绪」，用户下一次发送才会失败。

### 改动

**Runtime 新增明确的断线事件**（`packages/agent-runtime`）

- `event-normalizer.ts`：`AgentEvent` 新增
  `{ type: "disconnected"; reason: string; code?: number | null; signal?: string | null }`。
- `acp-client.ts`：transport `exit`（非预期）与 `error` 都先广播 `disconnected`，再 `failAll`。
  顺序很关键——先发断线事件，宿主才来得及在轮次失败前作废缓存。

**扩展层作废缓存 + 退避重连**（`src/agent-controller.ts`）

- `handleEvent` 新增 `case "disconnected"` → `handleDisconnected(reason)`。
- `handleDisconnected()`：清权限卡 → `invalidateRuntime()` → `ui.force("error")` →
  `store.patchRuntime({ connection: "failed" })` → 广播 `connection: failed` 与可恢复错误 →
  安排自动重连。用 `disconnected` 标志保证一次断线只处理一次。
- `invalidateRuntime()`：同步把 `runtime` / `startup` 置空，`dispose()` 只用来摘监听与写日志。
- `scheduleAutoReconnect()`：退避 1s → 3s → 8s，三次用完仍失败就提示用户手动重连。
- `reconnect({ auto })`：手动重连重置计数；自动重连失败会继续排下一次。
- `ensureStarted()` 增加存活性检查：`runtime && !runtime.processRunning` 时先作废再重启，
  兜住没有收到事件的边缘情况。
- `startRuntime()` 成功后复位 `disconnected` 与重连计数；`dispose()` 清理重连定时器。

`event-presenter.ts` 对 `disconnected` 返回空数组——提示与状态都归 Controller，避免重复报错行。

---

## 二、发送防重复与异常 Promise 兜底

**发送互斥**（`src/agent-controller.ts`）

`sendPrompt()` 拆成外层守卫 + `sendPromptInner()`。外层用 `sending` 标志，
在 `ui.canSend` 之外再加一道闸：UI 卡顿时连点发送不会再撞到 Runtime 的
「上一轮任务仍在执行」，而是收到一句「上一条消息还在发送中，请稍候」。

**消息路由错误边界**（`src/webview-message-handler.ts`）

三个调用点（`agent-panel.ts`、`chat-view-provider.ts`、`side-panels.ts`）都是
`void handleWebviewMessage(...)`，处理器抛错就会变成无人处理的 Promise rejection，
用户侧只看到「点了没反应」。现在把原有 switch 抽成内部 `dispatch()`，
外层统一 try/catch：写输出日志 + 回一条 `{ type: "error", recoverable: true }`。

---

## 三、整条消息复制、重试与停止状态

新增 `src/webview/message-actions.ts`（从 `main.ts` 抽出，便于在 JSDOM 下直接测试）：

- `attachMessageActions(root, options)`：悬浮操作条，默认透明，
  悬停或键盘聚焦时显示。复制实现可注入，方便测试。
- `createUserMessage(text, handlers)`：用户消息拆成 `.msg-text` 正文 + 操作条，
  避免操作条文字污染 `textContent`（否则复制会带上「复制」「重新发送」）。
- `markStopped(root)`：加 `.stopped` 类与「已停止生成」标记，幂等。
- `writeClipboard()`：优先异步剪贴板 API，失败退回 `execCommand`。

`main.ts` 接线：

- 用户消息：复制 + 重新发送（原文回传宿主）。
- 助手消息：复制原始 Markdown（不是渲染后文本）+ 重试上一轮请求。
  流式气泡封口时（`sealStreamingAssistant`）与会话恢复时（`mountAssistantMessage`）都会挂上。
- 停止状态：`requestStop()` 置 `stopRequested`，封口时给气泡打「已停止生成」；
  `assistantEnd` 的 stopReason 命中 cancel / abort / interrupt 也会打标；
  `busy: false` 后复位。

CSS 在 `main.css` 新增 `.msg-actions` / `.msg-action` / `.msg-stopped`。

---

## 四、会话操作改用 VS Code 原生 QuickPick

之前 `main.ts` 用 `window.prompt("输入：rename / pin / archive / delete")` 和 `window.confirm`，
观感远低于 VS Code 原生水准。

- `messages.ts` 新增 `{ type: "openSessionMenu"; sessionId: string }`，
  复用既有的 `isSafeId` 校验分支，路径形态的 id 在校验层就被丢弃。
- `agent-controller.openSessionMenu()`：原生 QuickPick，
  条目为「打开会话 / 重命名 / 固定·取消固定 / 归档·取消归档 / 删除」，
  按当前记录动态显示固定与归档的正反文案；重命名与删除复用已有的
  `showInputBox` 与 modal `showWarningMessage`。
- `main.ts`：右键与新增的 `⋯` 按钮都只发这一条消息。会话项改为
  `.session-row`（主按钮 + `⋯`），`⋯` 默认透明、悬停显示。

主面板已无 `window.prompt` / `window.confirm`。
遗留：旧版 `src/webview/plan-panel.ts` 仍有两处，属于待删除或降级的重复 Plan UI，留到后续处理。

---

## 五、快捷键

`package.json` 之前没有任何 `keybindings`，现补：

| 命令 | Windows / Linux | macOS | 条件 |
| --- | --- | --- | --- |
| 打开 Agent 主面板 | `ctrl+alt+l` | `cmd+alt+l` | — |
| 新建会话 | `ctrl+alt+n` | `cmd+alt+n` | — |
| 停止当前任务 | `ctrl+alt+backspace` | `cmd+alt+backspace` | `lingdongAgent.busy` |
| 切换模式 | `ctrl+alt+m` | `cmd+alt+m` | — |
| 会话历史 | `ctrl+alt+h` | `cmd+alt+h` | — |
| 添加选中代码 | `ctrl+alt+k` | `cmd+alt+k` | `editorHasSelection` |
| 添加当前文件 | `ctrl+alt+u` | `cmd+alt+u` | `editorTextFocus` |

`lingdongAgent.busy` 上下文键在 `postState()` 里通过 `setContext` 同步。

Webview 内快捷键：

- `Enter` 发送、`Shift+Enter` 换行（保持不变）
- `Ctrl/Cmd + Enter` 也发送
- `Escape` 先关浮层；没有浮层且正在执行时才停止
- `Ctrl/Cmd + I` 聚焦输入框

---

## 六、Grok 路径换机器失效

之前 `package.json` 把 `grokExecutable` 默认值写死为 `E:\LingdongCode\grok\bin\grok.exe`，
`grokHome` 写死为 `E:\LingdongCode\grok\data`，换机器即失效，且错误信息只有一句
「请在设置中配置」。

新增 `src/grok-locator.ts`（纯函数，依赖通过 `GrokLocatorDeps` 注入，便于测试）：

- 解析顺序：设置 → `LINGDONG_GROK_EXECUTABLE` 环境变量 → `PATH` 扫描 → 常见安装位置。
- Windows 按 `PATHEXT` 补 `.exe` / `.cmd` / `.bat`，POSIX 用无后缀名与 `:` 分隔。
- 常见位置：Windows 下 `%LOCALAPPDATA%\Programs\grok\bin` 等；
  POSIX 下 `/usr/local/bin`、`/opt/grok/bin`、`~/.grok/bin`、`~/.local/bin`。
- 设置里填了但文件不存在时返回 `configured-missing`，不静默回退——
  这种情况通常是换机器后残留的旧路径，静默回退会让人更困惑。
- `resolveGrokHome()`：设置优先，其次取可执行文件同级的 `data` 目录，都没有就继承环境变量。

配套：

- 两个配置项默认值改为空字符串，描述说明自动探测规则。
- 找不到时弹「选择可执行文件… / 打开设置」，选择后写入**用户级**设置
  （不是工作区级，换项目不用重配），并顺带推断 `GROK_HOME`，然后自动重连。
- 新增命令 `lingdongAgent.locateGrok`（灵动 Agent: 选择 Grok 可执行文件）。

---

## 七、测试

新增 3 个测试文件，共 21 个用例。

`tests/grok-locator.test.ts`（8 个）
设置命中、`configured-missing` 不静默回退、环境变量优先、PATH 扫描与 PATHEXT、
常见位置回退、POSIX 分支、not-found 提示可操作、GROK_HOME 推断。

`tests/message-actions.test.ts`（8 个，JSDOM）
用户消息正文与操作条分离、重新发送回传原文、复制取原始 Markdown 而非渲染文本、
复制成功反馈与复位、复制失败不假装成功、无 onRetry 时只渲染复制、
重复挂载不叠加、停止标记幂等。

`tests/webview-message-handler.test.ts`（4 个）
`openSessionMenu` 路由、路径形态 id 被校验层丢弃、
异步处理器抛错转为可恢复错误而非未捕获 rejection、同步抛错同样被兜住。

`tests/messages.test.ts` 增加 `openSessionMenu` 的校验用例。

`packages/agent-runtime/tests/acp-client.test.ts` 增加 3 个：
非预期退出先发 `disconnected` 再 `error`、预期关闭不发 `disconnected`、
传输层错误也广播 `disconnected`。

---

## 八、本轮未覆盖的项

按 `docs/product-status-and-optimization.md` 的排序，以下仍待处理：

- 拆分 `agent-controller.ts`（2411 行）与 `webview/main.ts`（1330 行）——
  建议先补控制器集成测试再动。
- 删除或降级旧版 `plan-panel.ts`，统一 Plan 交互（其中还有两处 `window.prompt`）。
- 消息区虚拟化与流式局部更新；`findFiles` 截断提示。
- Composer 内联 `@` 补全。
- 编辑重发与对话级检查点回滚。
- 多根工作区支持。
- 可访问性与 `l10n`。
