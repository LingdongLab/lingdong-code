# 灵动 Code 第三阶段 A/B/C 报告：灵动 Agent 扩展原型

日期：2026-08-04

## 结果摘要

| 项目 | 结果 |
|---|---|
| 阶段 A：Runtime 重构 | 完成，`packages/agent-runtime`（`@lingdong/agent-runtime`） |
| 阶段 B：扩展骨架 | 完成，`vscode-extension/lingdong-agent` |
| 阶段 C：基础通信 | 完成，ACP 初始化、会话、中文流式、停止、释放进程 |
| 原 PoC | 仍可运行，真实 Grok 终端联调退出码 0 |
| Agent Runtime 测试 | 19/19 通过（原 14 项全部保留 + 5 项新增） |
| 扩展测试 | 15/15 通过 |
| TypeScript strict 类型检查 | 三个包全部通过 |
| Grok Build | `0.2.118`，被识别为已测试版本 |
| ACP | 协议版本 1，JSON-RPC 2.0 换行帧 |
| 模型 | `deepseek-v4-flash`，真实中文流式回复 |
| 本轮未实现（阶段 D/E/F） | Plan 审批 UI、权限弹窗、Diff、会话历史、上下文 @、Code-OSS Fork、安装包 |

## 一、Runtime 重构结果

### 目录

```text
E:\LingdongCode
├── package.json                    # npm workspaces 根
├── packages\agent-runtime\         # @lingdong/agent-runtime
├── vscode-extension\lingdong-agent\
└── acp-poc\                        # 薄终端 CLI，依赖 Runtime
```

`acp-poc` 中已验证的协议实现被原样迁移，没有重写任何协议逻辑：

| 模块 | 说明 |
|---|---|
| `src/protocol.ts` | JSON-RPC 类型、`JsonLineDecoder` 换行帧拆包、`buildCancelNotification` |
| `src/process-manager.ts` | `spawn` 启动 Grok，`shell: false`，stdin/stdout NDJSON，退出与超时终止 |
| `src/acp-client.ts` | 初始化、新建/恢复会话、模式、提示词、取消、权限反向请求、`_x.ai/exit_plan_mode` |
| `src/event-normalizer.ts` | `session/update` → 统一 `AgentEvent` |
| `src/safety-policy.ts` | 工作区边界、路径穿越、删除、凭据、危险命令、四种模式策略 |
| `src/logger.ts` | `app.log` / `acp-raw.log` 与递归脱敏 |
| `src/version.ts` | 新增：Grok 可执行文件存在性与 `grok --version` 检测 |
| `src/agent-runtime.ts` | 新增：门面 `AgentRuntime` |

### 去掉的耦合

- 可执行文件、工作区、模型、日志目录、`GROK_HOME`、`clientInfo` 全部改为构造参数，Runtime 内不再有 `E:\LingdongCode` 硬编码。
- `AcpClient` 新增可选 `AcpClientConfig`（`modelId`、`clientInfo`），原有四参数构造保持兼容。
- Runtime 不依赖 VS Code API、DOM、Webview 或 readline。
- 默认权限处理为安全值：需人工确认一律拒绝，计划一律放弃；宿主可通过 `handlers` 注入自己的实现。

### 门面接口

```typescript
createAgentRuntime(options: RuntimeInitializeOptions): AgentRuntime

initialize(): Promise<RuntimeInfo>                 // 版本检测 + 启动 + ACP initialize
createSession(options?: CreateSessionOptions): Promise<string>
loadSession(sessionId: string, cwd?: string): Promise<void>
setMode(mode: AgentMode): Promise<void>
sendMessage(request: SendMessageRequest): AsyncIterable<AgentEvent>
cancel(): Promise<void>
dispose(): Promise<ProcessExit | undefined>
```

事件路由约定：一轮提示词执行期间事件只流向 `sendMessage` 的异步迭代器；轮次之外（模式切换、子进程异常）的事件通过 `runtime.on("event")` 发出。界面永远拿不到 Grok 原始 JSON。

`dispose()` 保持 0.2.118 的退出方式：没有 `session/close`，改为失败挂起请求 → 关闭 stdin → 等待退出 → 超时终止。

### 原 PoC 保持可用

`acp-poc/src/index.ts` 改为消费 `@lingdong/agent-runtime`，终端命令、权限选项与计划审批交互不变。真实 Grok 终端联调：

```json
{ "exitCode": 0, "timedOut": false, "bannerFound": true, "connectedFound": true, "cleanExitFound": true, "stderrEmpty": true }
```

## 二、扩展目录

```text
vscode-extension\lingdong-agent\
├── package.json              # 命令、视图容器、视图、配置项
├── tsconfig.json             # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
├── esbuild.mjs               # Host 打成 CJS，Webview 打成 IIFE
├── media\icon.svg
├── src\
│   ├── extension.ts          # 激活、命令注册、退出释放
│   ├── chat-view-provider.ts # WebviewView、CSP + nonce、消息路由
│   ├── agent-controller.ts   # 唯一接触 Runtime 的地方
│   ├── event-presenter.ts    # AgentEvent → 面板消息（不泄露思维原文）
│   ├── messages.ts           # Webview 消息类型与 schema 校验
│   ├── version-notice.ts     # 未测试版本提示文案
│   ├── workspace-guard.ts    # Host 侧二次路径校验
│   └── webview\main.ts / main.css
├── scripts\live-acp-check.mjs
├── tests\                    # 15 项单元测试
└── docs\phase-3-abc-report.md
```

### 视图位置

VS Code 从 2025 年下半年起才支持 `viewsContainers.secondarySidebar`，本机安装版本为 **1.84.2**，该键会被静默忽略、面板将完全不显示。因此视图容器注册在活动栏，并额外提供命令把视图移到辅助侧边栏：

- `lingdongAgent.open`：聚焦 `lingdongAgent.chatView`
- `lingdongAgent.moveToSecondarySideBar`：聚焦后调用 `workbench.action.moveFocusedView`，在弹出列表中选择「辅助侧边栏」

未修改 VS Code 内核。升级到支持该贡献点的 VS Code 后，只需把 `activitybar` 换成 `secondarySidebar` 并提升 `engines.vscode`。

### 已注册命令

`lingdongAgent.open`、`moveToSecondarySideBar`、`newSession`、`stop`、`switchMode`、`showLogs` 为可用命令；`addCurrentFile`、`addSelection`、`openDiff` 已注册但提示「阶段 E」。

### 配置项

```json
{
  "lingdongAgent.grokExecutable": "E:\\LingdongCode\\grok\\bin\\grok.exe",
  "lingdongAgent.grokHome": "E:\\LingdongCode\\grok\\data",
  "lingdongAgent.model": "deepseek-v4-flash"
}
```

### 安全边界

- Webview CSP：`default-src 'none'`，脚本只允许携带 nonce，样式与图片限定 `webview.cspSource`，`localResourceRoots` 只开放 `dist`。
- 所有 JS/CSS 打包在扩展目录，无远程 CDN。
- Webview 全部消息经 `parseWebviewMessage` 校验：类型白名单、模式白名单、提示词长度上限 20000，额外字段一律丢弃（测试覆盖伪造 `permissionOutcome`、`sessionId` 的情况）。
- 权限判断仍由 Runtime 的 `WorkspaceSafetyPolicy` 在 Host 侧完成，Webview 只展示已经做出的决定。
- Webview 不接触 Node、Shell、文件系统，不保存任何 Key。

## 三、启动方式

本机 `code` 不在 PATH，需使用完整路径。

```powershell
Set-Location E:\LingdongCode
npm install
npm run build

# 打开仓库后按 F5，选择「运行灵动 Agent 扩展」
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" E:\LingdongCode
```

F5 使用根目录 `.vscode/launch.json`，`preLaunchTask` 会先构建 Runtime 再构建扩展，并自动在 Extension Development Host 中打开 `E:\LingdongCode\workspace\grok-test`。

也可以直接启动开发宿主：

```powershell
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" `
  --extensionDevelopmentPath=E:\LingdongCode\vscode-extension\lingdong-agent `
  E:\LingdongCode\workspace\grok-test
```

在开发宿主中点击活动栏的「灵动 Agent」图标打开面板；需要放到右侧时执行命令「把灵动 Agent 移到辅助侧边栏」。

## 四、ACP 与 DeepSeek 联调结果

使用与 `AgentController` 完全相同的 Runtime 配置执行 `npm run check:live --workspace lingdong-agent`：

```json
{
  "protocolVersion": 1,
  "grokVersion": "0.2.118",
  "grokTested": true,
  "sessionId": "019fcd31-c3cd-7561-80e8-a8918c092e63",
  "ask": {
    "streamedChinese": true,
    "textLength": 304,
    "activityEvents": 47,
    "stopReason": "end_turn",
    "modelId": "deepseek-v4-flash",
    "workspaceUnchanged": true
  },
  "cancel": { "stopReason": "cancelled" },
  "shutdown": { "code": 0, "expected": true, "running": false },
  "outOfTurnEvents": ["status"]
}
```

对应本轮范围的验收：

| 项目 | 结果 |
|---|---|
| 启动 Grok Build | 通过，版本 0.2.118 被识别为已测试 |
| ACP 初始化 | 通过，协议版本 1 |
| 创建会话 | 通过 |
| 发送中文提示词 | 通过 |
| DeepSeek 实时流式回复 | 通过，304 字中文，`modelId=deepseek-v4-flash` |
| 工具与思考状态 | 47 次活动事件，全部映射为简洁中文状态 |
| Ask 只读边界 | 通过，工作区哈希未变化 |
| 停止任务 | 通过，`stopReason=cancelled` |
| 正常退出释放进程 | 通过，退出码 0，无残留进程 |

构建产物核对：`dist/extension.js`（CJS，正确导出 `activate`/`deactivate`）、`dist/webview/main.js`、`dist/webview/main.css`。

Extension Development Host 已启动，面板界面需要人工在窗口中确认；上述协议与模型链路已经通过与面板同源的代码路径验证。

## 五、测试

### `packages/agent-runtime`：19/19

原有 14 项全部保留：多消息拆包、半包缓存、非法 JSON 隔离、子进程异常退出、工作区边界、路径穿越、Ask 拒绝写入、Agent 人工确认、Auto 受限放行、删除拒绝、三项日志脱敏、无 ID 取消通知。

新增 5 项（使用 `tests/fixtures/fake-grok.mjs` 假 ACP 实现，不触达真实模型）：

- `sendMessage` 异步迭代产出流式文本并以 `completed` 结束
- `cancel` 让当前轮次以 `cancelled` 结束
- `dispose` 释放子进程且可重复调用
- 缺少 Grok 可执行文件时给出明确结果
- 版本号与已测试版本不一致时标记为未测试

### 灵动 Agent 扩展：15/15

- Webview 消息校验：合法消息、非法结构、越界长度、模式白名单、拒绝透传伪造字段
- 事件呈现：思考增量只输出固定状态文案且不含原文、重复状态不刷屏、文本与完成事件映射、权限事件只展示 Host 决定、未知形态工具事件仍可读
- 工作区边界：相对与绝对路径放行、路径穿越与工作区外拒绝、返回规范化绝对路径
- 版本提示：已测试、未测试（同时列出两个版本号）、缺少可执行文件

### 命令

```powershell
Set-Location E:\LingdongCode
npm test          # Runtime 19 + 扩展 15
npm run typecheck # 三个包 strict 类型检查
npm run build     # Runtime → PoC → 扩展
```

## 六、已知问题

1. **辅助侧边栏无法直接注册。** 本机 VS Code 1.84.2 不支持 `viewsContainers.secondarySidebar`，当前落在活动栏，用移动视图命令作为替代。
2. **面板界面未做自动化验证。** 阶段 C 的 UI 交互（按钮、流式渲染、Escape 停止）需要人工在 Extension Development Host 中确认；协议链路已由 `check:live` 覆盖。
3. **权限与计划在本轮为安全默认值。** Runtime 默认对需人工确认的操作返回拒绝、对 `_x.ai/exit_plan_mode` 返回放弃，面板只显示「计划审批界面将在阶段 D 提供」。因此本轮 Agent/Plan 模式无法完成写入类任务，属预期。
4. **会话不持久化。** 关闭扩展后会话不会自动恢复，`loadSession` 已在 Runtime 中可用但未接入 UI。
5. **模式切换按钮在 Runtime 启动前只改本地状态**，真正下发 `session/set_mode` 发生在会话建立之后。
6. **`acp-poc` 的联调脚本仍硬编码测试路径**，这是刻意保留的第二阶段验证脚本。
7. **依赖必须从仓库根目录安装**，`packages/agent-runtime` 需先构建出 `dist` 才能被 PoC 与扩展解析。

## 七、下一步

- 阶段 D：Plan 审批 UI（`[要求修改] [放弃计划] [批准执行]`）、权限确认卡片、Ask/Plan/Agent/Auto 完整策略接线，`_x.ai/exit_plan_mode` 继续封装在 Runtime 内。
- 阶段 E：`@当前文件`、`@选中代码`、`@指定文件`、`@指定文件夹`、`@终端输出`；本轮文件变更列表、快照模块、`vscode.diff`、撤销本轮修改。
- 阶段 F：`workspaceState` 会话存储、历史与重命名删除、恢复会话、未测试版本的「选择兼容版本」流程、文档完善。

## 八、修改文件清单

### 新增

```text
package.json
.gitignore
.vscode\launch.json
.vscode\tasks.json
packages\agent-runtime\package.json
packages\agent-runtime\tsconfig.json
packages\agent-runtime\tsconfig.typecheck.json
packages\agent-runtime\src\index.ts
packages\agent-runtime\src\agent-runtime.ts
packages\agent-runtime\src\version.ts
packages\agent-runtime\src\acp-client.ts
packages\agent-runtime\src\event-normalizer.ts
packages\agent-runtime\src\logger.ts
packages\agent-runtime\src\process-manager.ts
packages\agent-runtime\src\protocol.ts
packages\agent-runtime\src\safety-policy.ts
packages\agent-runtime\tests\acp-client.test.ts
packages\agent-runtime\tests\agent-runtime.test.ts
packages\agent-runtime\tests\logger.test.ts
packages\agent-runtime\tests\process-manager.test.ts
packages\agent-runtime\tests\protocol.test.ts
packages\agent-runtime\tests\safety-policy.test.ts
packages\agent-runtime\tests\version.test.ts
packages\agent-runtime\tests\fixtures\fake-grok.mjs
vscode-extension\lingdong-agent\package.json
vscode-extension\lingdong-agent\tsconfig.json
vscode-extension\lingdong-agent\esbuild.mjs
vscode-extension\lingdong-agent\media\icon.svg
vscode-extension\lingdong-agent\src\extension.ts
vscode-extension\lingdong-agent\src\chat-view-provider.ts
vscode-extension\lingdong-agent\src\agent-controller.ts
vscode-extension\lingdong-agent\src\event-presenter.ts
vscode-extension\lingdong-agent\src\messages.ts
vscode-extension\lingdong-agent\src\version-notice.ts
vscode-extension\lingdong-agent\src\workspace-guard.ts
vscode-extension\lingdong-agent\src\webview\main.ts
vscode-extension\lingdong-agent\src\webview\main.css
vscode-extension\lingdong-agent\src\webview\css.d.ts
vscode-extension\lingdong-agent\scripts\live-acp-check.mjs
vscode-extension\lingdong-agent\tests\messages.test.ts
vscode-extension\lingdong-agent\tests\event-presenter.test.ts
vscode-extension\lingdong-agent\tests\workspace-guard.test.ts
vscode-extension\lingdong-agent\tests\version-notice.test.ts
vscode-extension\lingdong-agent\docs\phase-3-abc-report.md
```

### 修改

```text
acp-poc\package.json
acp-poc\README.md
acp-poc\src\index.ts
acp-poc\tests\live-smoke.ts
acp-poc\tests\live-cancel-load.ts
acp-poc\tests\terminal-smoke.ts
```

### 删除（迁移到 `packages/agent-runtime`）

```text
acp-poc\src\acp-client.ts
acp-poc\src\event-normalizer.ts
acp-poc\src\logger.ts
acp-poc\src\process-manager.ts
acp-poc\src\protocol.ts
acp-poc\src\safety-policy.ts
acp-poc\tests\acp-client.test.ts
acp-poc\tests\logger.test.ts
acp-poc\tests\process-manager.test.ts
acp-poc\tests\protocol.test.ts
acp-poc\tests\safety-policy.test.ts
```
