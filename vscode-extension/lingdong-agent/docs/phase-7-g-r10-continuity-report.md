# G-R10 阶段报告：对话连续性一期（截断修复 / 静默看门狗 / 发送队列 / 连接加速）

日期：2026-08-06
范围：`packages/agent-runtime` + `vscode-extension/lingdong-agent`
借鉴来源：[grok-app](https://github.com/RongleCat/grok-app)（`session-continuity.md` 记载的截断坑、静默超时阈值实测值、忙时排队与预热策略）

## 目标

1. **阶段 A · 轮次结束信号修复**：修掉「最后半句话被冻结在轮次外」的真 bug。
2. **阶段 B · 静默看门狗**：模型挂死不再永久转圈，长任务不被误杀。
3. **阶段 C · 忙时发送队列**：执行中继续打字不再被硬拒绝，对标 Cursor 排队续发。
4. **阶段 D · 连接加速**：`--no-auto-update`、面板打开即预热、未连接切会话补 `session/load`。

## 阶段 A：轮次结束信号修复（真 bug）

**问题**：`acp-client.ts` 的 `handleMessage` 第一句 `await logger.raw(...)` 之后才分发，而
`process-manager.ts` 把同一 stdout 块里的多条消息并发 `void` 处理——日志 `appendFile` 完成顺序
不保证 FIFO。最后一条 `agent_message_chunk` 与 `session/prompt` 响应同帧到达时，`completed`
可能先被处理，事件流提前 break，正文尾巴落在轮次外（与 grok-app `session-continuity.md` 同源）。

**修复**：

- 入站消息**严格串行**：`transport.on("message")` 把 `handleMessage` 挂到一条 promise 链上依序执行，
  到达顺序 = 处理顺序。
- 日志移出关键路径：`SafeLogger` 内部加写入串行队列（并发调用按提交顺序落盘），
  `handleMessage` 对 raw 日志改为 `void`，不再阻塞分发。
- cancel 兜底：`cancel()` 后若 Grok 不回 prompt 响应，`cancelGraceMs`（默认 15s）静默超时后
  合成 `completed(stopReason=cancelled)`，事件流不再永久挂起。
- 回归测试：`fake-grok.mjs` 新增「同帧收尾」场景（最后一段正文与 prompt 响应写进同一次
  stdout write），断言 `text_delta` 全部先于 `completed` 产出、正文无缺失。

## 阶段 B：静默看门狗

- `AcpClient.request()` 新增可选静默 deadline（`RequestWatch`）：任何入站活动
  （`session/update`、反向 RPC）都会 `touchActivity()` 重置所有在飞请求的空闲计时。
- `session/prompt`：静默 10 分钟 + 绝对 4 小时上限（对齐 grok-app 实测值，`WatchdogConfig`
  可注入便于测试）。触发后 reject（文案「模型长时间无响应，已停止本轮任务」）+
  `session/cancel` + `clearPendingAsync`，宿主现有错误链路自然接住。
- `session/load` 从 30 秒固定墙钟改为同款静默检测（回放期间的更新流不断 touch），
  大会话不再误超时。
- **等人不算静默**：待回执的权限卡 / 计划审批 / 提问卡是「开着的门」（`hasOpenGates`），
  看门狗只顺延不触发；用户回应（respondPermission/Plan/Question）也算活动。
- 新增 `turn-continuity.test.ts` 五个场景：同帧收尾、静默挂死、缓慢输出不误杀、
  权限等待顺延、取消不回包兜底。

## 阶段 C：忙时发送队列

**宿主**（`turn-service.ts` / `turn-state.ts`）：

- `TurnState.sendQueue`（上限 10 条）；`send()` 忙时（`sending` 或 `ui.busy`）改为入队并回执
  `sendQueue` 快照，不再报错。
- 自动续发：`send()` 的 `finally` 出队下一条（走完整 send，Ask 意图拦截照常生效）；
  **用户取消（cancelled）与错误态不自动续发**，队列保留待手动处理。
- `initializing`（预热/重连过渡态）发送直接放行——`sendInner` 里的 `ensureStarted()`
  会等在飞的启动完成（启动有并发去重）；连接就绪（`onReady`）时也会 `drainQueue()` 兜底续发。
- 清空时机：新建会话、切换会话。
- 新消息：`sendQueue`（宿主→webview 全量快照）、`queueRemove` / `queueFlush`（webview→宿主）。

**webview**（`composer.ts` / `message-router.ts`）：

- `submit()` 放开 busy 早退：忙时照常上抛（宿主负责入队），输入框清空，不再静默丢弃；
  placeholder 改为「任务执行中……Enter 排队发送，Esc 停止」。
- composer 上方渲染队列 chips：条目截断显示 + 删除按钮常在 + 空闲时出现「立即发送」。
- 既有集成测试「上一条还在发送时拒绝重复发送」按新语义改写为「排队并自动续发」。
- 新测试：`send-queue.test.ts`（宿主队列行为）、`queue-chips.test.ts`（JSDOM 提交路径与 chips）。

## 阶段 D：连接加速

- `agent-runtime.ts` 默认 args 改为 `["--no-auto-update", "agent", "-m", model, "stdio"]`；
  已用真机 grok 0.2.118 验证该全局 flag 位置被 CLI 接受（`grok --no-auto-update agent --help` 正常）。
- **面板预热**：`AgentController.syncState()` 里后台触发一次 `ensureStarted()`（每实例只试一次）。
  失败只记 `[preheat]` 日志，不弹错误卡；若失败把状态机留在 `initializing`，强制退回 `idle`，
  发送路径自己重试。
- **补缺口**：`SessionService.load()` 在 runtime 未连接时，后台预热完成后补做 `bindGrokSession`
  （带「用户已切走」与「启动编排已绑定同一会话」两道守卫，不重复 load）。
- **预热与关闭的竞态**：`RuntimeService.shutdown()` 先等在飞的启动落地再清场，
  否则本地模型代理会在 `stopProxy()` 之后才被拉起、没人回收（测试进程曾因此悬死）。
- 新测试：`connection-preheat.test.ts` 三个场景——面板挂载即预热且只预热一次、
  预热失败不锁 UI 且发送自动重试、未连接切会话预热后自动补 load。

## grok-app 借鉴对照

| grok-app 做法 | 本项目落地 | 差异 |
| --- | --- | --- |
| 串行处理 stdout 消息避免截断 | 入站 promise 链串行 + 日志串行队列 | 我们把日志也移出关键路径 |
| prompt 静默 10min / 绝对 4h 超时 | 同阈值，`WatchdogConfig` 可注入 | 增加「开着的门」顺延（等用户不算静默） |
| 忙时消息排队、轮次结束续发 | `sendQueue` + chips UI | 增加取消不续发、10 条上限、立即发送 |
| 启动即连接（预热） | `syncState` 后台 `ensureStarted` | 增加失败退回 idle、shutdown 等待在飞启动 |

## 验证

- `packages/agent-runtime`：typecheck ✅ · 98/98 测试 ✅ · build ✅
- `vscode-extension/lingdong-agent`：typecheck ✅ · 770/770 测试 ✅ · build ✅
- 真机 CLI flag 验证：`grok 0.2.118` 接受 `--no-auto-update` ✅
- 待手工验证（真实会话）：长回复无截断；挂死 10 分钟出明确报错；忙时连发 3 条依序执行；
  Esc 停止后队列保留；打开面板即连接、切旧会话首发不冷启动。
