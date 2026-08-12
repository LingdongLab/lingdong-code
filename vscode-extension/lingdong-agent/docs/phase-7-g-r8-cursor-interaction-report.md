# G-R8 阶段报告：对标 Cursor 的交互反馈（执行反馈 / 计划勾选 / 模型提问）

日期：2026-08-06
范围：`packages/agent-runtime` + `vscode-extension/lingdong-agent`

## 目标

对标 Cursor 编辑器的三项交互体验：

1. **阶段 A · 执行实时反馈**：执行时不点开就能看到正在做哪一步、动了哪个文件。
2. **阶段 B · 计划逐项勾选**：会话流里出现一张随执行更新的任务清单，完成一项划掉一项。
3. **阶段 C · 模型主动提问**：模型不确定时向用户提问（单选/多选 + 自由文本），拿到答案继续执行。

## 阶段 A：执行实时反馈（纯呈现层）

- 运行中的活动分组默认展开，条目行实时可见；分组进入终态自动收拢成一行摘要，
  用户手动展开过的已完成分组不会被再次合上（`activity-group-view.ts`）。
- 运行中分组的标题行追加当前条目文案（如「正在修改 src/foo.ts」），条目结束即消失。
- 轮次终态兜底：没收到收尾消息的分组（如轮次被打断）在停表时一并收拢（`timeline-view.ts`）。
- 配套样式：当前条目行、running 态时间线左边条、进行中条目高亮（`timeline.css`）。
- 隐私边界不变：仍不显示原始推理文本与命令 stdout。

## 阶段 B：内联 todo 清单

数据链修复（此前状态在三处被丢弃，永远勾不上）：

- `AgentPlanStep` / `PlanStepView` 增加结构化 `status`（pending / in_progress / completed / failed / cancelled）。
- `event-normalizer.ts` 的 `planFromEntries` 保留结构化状态，中文 `detail` 文案仅作旧会话回放兜底。
- webview 侧 `mapCardSteps` 不再把步骤强制回 `pending`。

内联渲染：

- 新增 `src/webview/todo-card.ts`：会话流内的清单卡片，整个会话只保留一张、重复下发就地更新；
  completed 打勾 + 删除线，in_progress 高亮圆点，头部显示进度 N/M。
- `message-router.ts`：status 为 `executing` 的 plan 卡路由到 todo 卡；审批态计划仍走原计划文档流，两线不混。
- 回放走既有 `plan` 消息持久化，历次更新依序重放、停在终态。
- 旧版会话记录无结构化状态时，从 `detail` 的「状态：X」文案倒推（`stepUiStatus`）。

## 阶段 C：模型提问（ask_user_question 全链路）

Grok 0.2.118 原生支持：模型调用内置 `ask_user_question` 工具后，Grok 向客户端发反向 RPC
`_x.ai/ask_user_question` 并阻塞等待。此前 `acp-client.ts` 用 -32601 拒收，模型侧直接报错。

### 运行时（agent-runtime）

- 新增 `src/ask-question.ts`：请求宽容解析（对象/字符串选项都收、坏条目丢弃、multiSelect null 归一）。
- `acp-client.ts`：登记未决提问、发出 `question_requested` 事件、`respondQuestion(requestId, answers)` 回执；
  取消/清场/断连时以 `skip_interview` 温和跳过，不把工具打成失败、不让 Grok 悬死。
- 事件：`AgentEvent` 增加 `question_requested` / `question_resolved`（后者带 answers 供转录）。

### 应答形状（真实会话逐步验证的结论）

二进制与实测确认：应答是内部标签枚举 `AskUserQuestionExtResponse`，标签字段 `outcome`，
变体 `accepted`（字段 `answers`、`partial_answers`）/ `skip_interview` / `chat_about_this`。

- 回答：`{ "outcome": "accepted", "answers": { "<问题原文>": "答案" } }` —— **answers 是映射不是数组**，值为 StringOrVec。
- 跳过：`{ "outcome": "skip_interview" }`。
- 踩过的坑（均已写进 `ask-question.ts` 顶部注释）：漏 `outcome` 报 `missing field outcome`；
  answers 发数组报 `invalid type: sequence, expected a map`。

### 宿主与 UI（lingdong-agent）

- `messages.ts`：`askQuestion` / `askQuestionResolved`（宿主→webview）与 `answerQuestion`（webview→宿主，
  带 requestId 校验、答案条数与长度上限、空串保位对齐）。
- `ui-state.ts`：新增 `waiting_question` 等待态（可取消整轮，计入执行中状态）。
- 新增 `services/question-facade.ts`：出卡片、进出等待态、答案按题目下标对齐（缺补空串、多截掉）、
  状态守卫、运行时报错时退出等待态不悬死、面板重挂补推当前卡。
- webview 问答卡（`conversation.ts`）：单选 radio / 多选 checkbox（带选项 preview），每题「其他」自由文本；
  答完所有题才能提交，提交/收尾后整卡锁死；同一 requestId 不重复挂卡。
- 转录持久化（`transcript-repository.ts`）：`question` 条目落盘前脱敏；回答后更新答案；
  回放为「问题 → 答案」摘要通知；重启后未决提问标记失效。
- `grok-config-writer.ts`：托管 config.toml 写入 `[toolset.ask_user_question] timeout_enabled = false`，
  与 Cursor 一致地无限等待用户作答。
- `event-classifier.ts`：提问工具不进时间线（由问答卡呈现）。
- 思考指示器在问答卡出现时让位（等的是用户不是模型）。

## 顺手修掉的上游兼容问题（净化代理）

真实联调时踩中两个新的 Grok 严格反序列化故障，都发生在 Poe 模型调用工具时：

1. **choices/tool_calls 条目缺 `index`**：Poe（实测 claude-opus-4.8）的工具调用分片里
   `choices[0]` 没有 `index`，Grok 报 `missing field index`，纯聊天没事、一调工具就炸。
   修法：`usage-sanitizer.ts` 按条目在数组中的位置补上（正是该字段的规范语义），预检用
   「首元素第一个键不是 index」的正则保住快路径。
2. **`*_details` 整体为 null 被误归零**：原 usage 修补把 `completion_tokens_details: null`
   改成 `0`，Grok 报 `expected struct CompletionTokensDetails`。修法：对象值的 `_details` 键保持 null，
   只有计数字段的 null 才归零。

## 测试与验证

- 运行时 `npm test`：88/88 通过（新增 `tests/ask-question-flow.test.ts` 6 例，已登记 package.json）。
- 扩展 `npm test`：727/727 通过。新增/更新并登记：
  `tests/question-facade.test.ts`（8 例）、`tests/ask-question-card.test.ts`（5 例）、
  `tests/todo-card.test.ts`（6 例）、timeline-view / plan-view-model / event-normalizer /
  transcript-repository / grok-config-writer / model-proxy 相应补充用例。
- 两包 typecheck、build 全绿。
- **真实会话验证**（`scripts/live-ask-question-check.mjs`，Poe claude-opus-4.8，经本地净化代理）：
  模型调用 ask_user_question → 客户端收到反向 RPC（形状与实现一致）→ 回执映射答案 →
  模型复述「你选了蓝色。」→ `end_turn` 正常收尾。

## 手工验证建议（重载扩展后）

1. **执行反馈**：发一个改文件的任务，确认运行中的分组自动展开、标题行显示「正在修改 xxx」，完成后收拢。
2. **todo 勾选**：发一个多步骤任务，确认会话流里的任务清单随执行逐项打勾、进度 N/M 更新、只有一张卡。
3. **模型提问**：发「先用 ask_user_question 问我一个问题再继续」，确认问答卡出现、
   选择后提交、模型拿到答案继续；期间点停止应能取消整轮且卡片置灰。

## 已知边界

- 提问卡不设本地超时（Grok 侧超时已关闭），用户不作答任务会一直等；取消整轮是唯一出口，这与 Cursor 行为一致。
- 同一提问里问题原文重复时，answers 映射会合并为一条（Grok 侧键冲突），实测模型不会这么出题，不做特殊处理。
- `chat_about_this` 变体（在聊天里继续讨论）客户端暂不使用。
