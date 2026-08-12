# 灵动 Code 第六阶段 F 完成报告

会话历史、持久化、恢复与上下文管理。

## 1. 存储架构

独立存储层，Webview 不直接读写磁盘。

```
Webview → AgentController → SessionPersistence / Runtime
                              ↓
              globalStorageUri/
                agent-sessions/<workspaceHash>/
                  index.json
                  <sessionId>/session.json
                  <sessionId>/transcript.json
                  <sessionId>/turns.json
                  <sessionId>/plans.json
                agent-snapshots/<workspaceHash>/
                  <sessionId>/<turnId>/{manifest.json, files/}
```

核心模块：

| 模块 | 职责 |
|------|------|
| `JsonStore` | 原子写入（`.tmp` → `.bak` → rename）、损坏归档、schemaVersion |
| `StorageMigrationService`（`storage-migration.ts`） | 版本迁移登记表 |
| `SessionRepository` | 工作区级会话索引与 SessionRecord |
| `TranscriptRepository` | 对话/工具/Plan/权限摘要 |
| `TurnRepository` | AgentTurn + ChangedFile 摘要 |
| `PlanRepository` | PlanRecord 持久化 |
| `ContextUsageService` | exact / estimated / unavailable 用量 |
| `SessionPersistence` | 把门面绑到 Controller |
| `GrokBuildAdapter` | 版本相关 compact 探测与调用 |

第一版使用 JSON，不引入原生 SQLite；接口可替换。

## 2. SessionRecord

至少包含：`id`、`workspaceId`（路径哈希）、`grokSessionId`、`title`、`titleSource`（auto/manual/placeholder）、时间戳、`modelId`、`localMode`/`serverMode`、`status`、`archived`/`pinned`、计数、`activePlanId`、`lastTurnId`、`contextUsage`、`pendingChanges`、`conflictChanges`、`hasUnfinishedPlan`、`schemaVersion`。

不同工作区哈希不同，会话绝不混用。

标题：首轮结束后本地规则生成（最大 40 字符）；手动重命名后不再被自动覆盖。

## 3. 消息持久化

恢复所需内容：用户消息、Agent 回复、工具摘要、Plan 卡片、权限决定、模式、错误、变更摘要、上下文标签、停止原因。

不保存：API Key、环境变量、凭据、未脱敏终端输出、Grok 原始帧、Webview HTML、无限工具输出。

工具输出：脱敏后截断至 20 000 字符。

## 4. Grok session/load

- Runtime 已有 `loadSession`；扩展在启动/切换会话时调用。
- `loadSession` 结束后会按当前本地模式 `setMode`。
- 失败提示：「底层 Agent 会话无法恢复，已保留本地记录，可以从当前状态创建新会话继续。」并 `createSession` 更新 `grokSessionId`。
- **限制**：Grok 0.2.118 无 `session/close`；删除本地会话只删灵动 Code 索引与记录，不删 Grok 数据目录。

联调场景二：`session/load` 成功，续聊文本长度 679，上下文延续。

## 5. PlanRecord

状态：`draft` / `waiting_review` / `approved` / `executing` / `paused` / `completed` / `abandoned` / `cancelled`。  
每次改写 `version + 1`。步骤含 id/order/title/description/files/status/时间戳。

命令 `lingdongAgent.savePlan` 写入 `.lingdong/plans/<日期>-<slug>.md`，经工作区边界校验。本阶段不做可编辑 Plan 编辑器。

## 6. 未处理变更恢复

1. `SnapshotStore.hydrate()` 回读 manifest  
2. `ChangeTracker.rehydrate` + `reevaluate` 重算磁盘哈希  
3. 判定 pending / accepted / restored / conflict / snapshot_missing  
4. 快照缺失：`restorable=false`，不伪造撤销  

联调：场景四拒绝后状态 `restored`；场景五外部修改后标记 conflict，用户内容保留。

## 7. 快照清理

配置：

- `lingdongAgent.snapshotRetentionDays` 默认 30  
- `lingdongAgent.snapshotMaxTotalMb` 默认 512  

启动后延迟清理：删除超期 accepted/restored；pending/conflict 永不删除；孤立 manifest 记日志；超配额优先删最旧可回收项，仍不足则警告用户。

## 8. 损坏恢复

写入：`.tmp` → 旧文件改 `.bak` → rename。  
读取：主文件坏 → 回退 `.bak` → 仍失败则改名为 `.corrupt-<时间戳>`，返回空仓库 + UI/日志提示，Extension Host 不崩溃。

联调场景七：`status=recovered`，标题「完好备份」。

## 9. 上下文用量

- **exact**：仅当 `_x.ai/session/update` 的 `turn_completed.usage` 到达  
- **estimated**：分项估算（系统规则/历史/文件上下文/工具输出/Plan/当前任务），UI 必须标「约」  
- **unavailable**：尚无数据  

阈值事件（仅数据层）：`normal` / `warning`(70%) / `critical`(85%) / `full`(95%)。完整百分比界面留阶段 G。

本机 `deepseek-v4-flash`：`context_window = 1000000`。

## 10. Grok 0.2.118 自动压缩调查

| 项 | 结论 |
|----|------|
| 自动压缩 | 有。`[session] auto_compact_threshold_percent = 85`（默认 85%） |
| 配置位置 | `grok/data/docs/user-guide/05-configuration.md`、本机 `config.toml` |
| ACP 上报 compact 事件 | 文档提到 `x.ai/session_notification`；本轮联调未触发自动压缩实例 |
| 精确 usage | 协议有 `_x.ai/session/update` + `turn_completed.usage`；Runtime 已订阅。本轮短任务联调未观测到 exact 上报（`exactUsageSeen=false`），能力以单元测试与协议样本为准 |
| initialize.agentCapabilities | 含 `loadSession: true` 等 |

## 11. 手动 compact 能力

| 项 | 结论 |
|----|------|
| TUI `/compact` | 存在，但是 TUI slash，不作为 ACP 文本 prompt |
| ACP 扩展方法 | `GrokBuildAdapter` 探测 `compact_conversation` / `_x.ai/compact_conversation` / `session/compact` |
| 联调探测结果 | **`compactCapability = available`**（本机 0.2.118 探针成功） |
| 封装位置 | `packages/agent-runtime/src/grok-build-adapter.ts`，经 `AgentRuntime.probeCompact` / `compactConversation` 暴露；**禁止**把 `/compact` 当普通用户消息 |

## 12. 测试数量与结果

| 包 | 通过数 |
|----|--------|
| `@lingdong/agent-runtime` | **71** |
| `lingdong-agent` | **180** |
| **合计** | **251** |

原 167 项全部保留并继续通过；新增覆盖会话 CRUD、原子写入/损坏恢复、标题、transcript、turn、plan、hydrate/reevaluate、用量、messages、compact 探针等。

## 13. 八项真实联调

工作区：`E:\LingdongCode\workspace\grok-test`  
结果文件：`docs/phase-6-live-result.json`  
命令：`npm run check:phase6 --workspace lingdong-agent`

| 场景 | 结果 |
|------|------|
| 1. 会话恢复 | 通过：标题/消息/模式/模型读回 |
| 2. session/load | 通过：会话 ID 一致，续聊 679 字 |
| 3. Plan 恢复 | 通过：2 步计划，`waiting_review` |
| 4. 未处理变更恢复 | 通过：拒绝后 `restored`，快照可读 |
| 5. 冲突恢复 | 通过：conflict + 用户内容保留 |
| 6. 工作区隔离 | 通过：哈希不同，列表不串 |
| 7. 损坏恢复 | 通过：从 `.bak` 恢复 |
| 8. 用量与压缩 | 通过：compact=`available`；exact 本轮未上报，source=`unavailable`（不伪造数字） |

## 14. 已知问题

1. **短任务可能无 exact usage**：`turn_completed` 并非每轮都进入客户端迭代器可见路径；数据层已接好，阶段 G UI 需同时支持 estimated。  
2. **无 session/close**：删除会话不清理 Grok `sessions/` 目录。  
3. **标题规则偏保守**：对「用一句话说明…」类提问剥离有限，可能接近原文截断。  
4. **快照清理跨会话**：当前启动清理主要基于已打开会话的 turns + 全量 hydrate；多会话配额统计已有 scan，后续可扫全部 turns.json。  
5. **历史 UI 为 Quick Pick**：符合阶段 F「不做三栏会话树」；阶段 G 再做侧栏会话树。

## 15. 下一阶段 G 建议

1. 三栏布局与会话树（固定/归档/搜索）  
2. 上下文用量百分比条与 compact 按钮（已有 available 能力）  
3. 可编辑 Plan 编辑器（增删改步骤、暂停续跑）  
4. Debug 模式完整界面  
5. 勿 Fork Code-OSS；继续扩展宿主方案  

## 16. 修改文件清单

### 新增

- `vscode-extension/lingdong-agent/src/storage/json-store.ts`
- `vscode-extension/lingdong-agent/src/storage/storage-migration.ts`
- `vscode-extension/lingdong-agent/src/storage/session-repository.ts`
- `vscode-extension/lingdong-agent/src/storage/transcript-repository.ts`
- `vscode-extension/lingdong-agent/src/storage/turn-repository.ts`
- `vscode-extension/lingdong-agent/src/storage/plan-repository.ts`
- `vscode-extension/lingdong-agent/src/session-title.ts`
- `vscode-extension/lingdong-agent/src/session-persistence.ts`
- `vscode-extension/lingdong-agent/src/context-usage.ts`
- `vscode-extension/lingdong-agent/src/plan-markdown.ts`
- `packages/agent-runtime/src/grok-build-adapter.ts`
- `vscode-extension/lingdong-agent/scripts/live-phase6-check.mjs`
- `vscode-extension/lingdong-agent/docs/phase-6-live-result.json`
- `vscode-extension/lingdong-agent/docs/phase-6-f-report.md`
- 测试：`json-store` / `session-repository` / `session-title` / `transcript-repository` / `turn-repository` / `plan-repository` / `plan-markdown` / `context-usage` 等

### 修改

- `packages/agent-runtime/src/acp-client.ts`（`_x.ai/session/update`、`loadSession`+setMode、`extensionRequest`）
- `packages/agent-runtime/src/agent-runtime.ts`（compact 探针、loadSession mode）
- `packages/agent-runtime/src/event-normalizer.ts`（`token_usage` / `context_compacted`）
- `packages/agent-runtime/src/index.ts`
- `vscode-extension/lingdong-agent/src/file-system-port.ts`（rename / listEntries）
- `vscode-extension/lingdong-agent/src/snapshot-store.ts`（hydrate / scan / cleanup 配额）
- `vscode-extension/lingdong-agent/src/change-tracker.ts`（rehydrate / reevaluate）
- `vscode-extension/lingdong-agent/src/agent-controller.ts`（持久化接入、历史、恢复、清理）
- `vscode-extension/lingdong-agent/src/messages.ts` / `webview/main.ts` / `chat-view-provider.ts` / `extension.ts` / `event-presenter.ts` / `package.json`

---

阶段 F 完成。未开始阶段 G，未 Fork Code-OSS，未重写阶段 D/E 已通过的权限、快照、Diff 与恢复核心逻辑。
