# G-R9 阶段报告：对标 Cursor 二期（卡片治理 / 免重连切模 / 输入框 / 计划文档）

日期：2026-08-06
范围：`packages/agent-runtime` + `vscode-extension/lingdong-agent`

## 目标

四个方向对标 Cursor：

1. **阶段 A · 卡片与打扰治理**：低风险操作自动判断放行、已决卡片收拢、任务进度常驻可见。
2. **阶段 B · 跨 Provider 切模型免重连**：命中启动快照的模型走 `session/set_model` 秒切。
3. **阶段 C · 输入框与对话栏打磨**：composer 紧凑化、粘底滚动、代码高亮、流式渲染稳定。
4. **阶段 D · 计划文档升级**：markdown 渲染、实时 N/M 进度、执行状态写回步骤、修审批链 bug、补 revisePlan UI。

## 阶段 A：卡片与打扰治理

**自动判断（safety-policy.ts）**：

- Agent 模式风险矩阵改为：低风险（普通源码写入、只读命令）自动放行，medium/high 仍问，blocked 仍拒。
- beforeWrite 快照守卫不变：自动放行的写入同样先过快照钩子，Changes 面板照常可撤销
  （新增运行时测试「Agent 模式低风险写入自动放行，且先过写入前钩子」守护）。
- 自动放行的 `permission_resolved` 通知不再进对话流（工具本身已在时间线里）；自动拒绝仍然可见。

**已决卡片收拢（conversation.ts / dom-utils.ts）**：

- 新增 `collapseCard`：权限卡、提问卡、ask-intent 卡、debug 确认卡在用户操作/超时/取消后收拢成一行结论
  （「已允许：运行 npm install」），不再全尺寸滞留；debug 卡不禁用的 bug 一并修掉。
- 变更摘要卡跨轮收拢：新一轮的卡出现时，把更早轮次的卡收拢成一行并保留「查看变更」入口（message-router.ts）。

**任务进度常驻可见（todo-card.ts / agent-panel.ts）**：

- composer 上方新增任务进度条：`任务进度 3/5 · 正在：修改 login.html`，点击滚动定位到 todo 卡。
- 修复「加载更早消息」把 todo 卡回写成旧快照的回滚 bug：更新按会话内时序号排序，旧序号直接忽略。
- todo 卡标题随更新刷新。

## 阶段 B：跨 Provider 切模型免重连

- `runtime-env.ts` `buildChildEnv`：凭据注入从单把改为数组（仅 `LINGDONG_KEY_*` 槽位）。
- `provider-service.ts` `buildEnv`：注入**所有已启用且配置了密钥**的 Provider；新增启动快照
  （已注入 providerId + config.toml 模型列表）。
- `model-facade.ts` `select`：目标模型命中快照 → `session/set_model` 免重连秒切（切完立即重发 models 回显）；
  未命中（会话中途新加的 Provider/模型）→ 兜底重连并提示原因；无快照（未托管 home）退回同 Provider 规则。
- `model-switch-guard.test.ts` 重写：断言全量注入、跨 Provider 零重启、快照未命中兜底重连、
  删除凭据不静默回退等不变量。
- 隐私边界变化已写入 `docs/privacy/grok-network-audit.md`：宿主环境其他凭据仍全部剥离，
  禁用 Provider 后下次启动不再注入其密钥。

## 阶段 C：输入框与对话栏打磨

**Composer**：

- 输入框最小高度 96px → 44px（1 行起步，自动长高到 220 上限）；`rows=1`。
- 发送/停止合并为单个形态切换按钮（空闲=发送，运行中=停止），Esc 停止保留。
- 边框/圆角/focus-within 聚焦环对齐 Cursor 质感，底栏间距收紧。

**对话栏**：

- 粘底滚动统一：scroll 监听维护「用户已离底」状态，离底时新内容不再强制拉底；
  浮动「回到底部」按钮在离底且有新内容时出现。
- 代码块语法高亮：highlight.js 常用语言子集，只在流式终稿/静态挂载时跑，中间帧不重算。
- 流式围栏稳定：尾块是未闭合代码围栏时只更新 `<code>` 文本不整块重建，消除工具条每帧闪烁。

## 阶段 D：计划文档对标 Cursor

- **markdown 渲染**：`toPlanCard` 现在始终携带脱敏原文；计划文档正文改用现有 markdown 管道
  （markdown-it + DOMPurify + enhanceMarkdownDom）渲染 `PlanRecord.raw`，有原文时不再重复铺
  目标/文件/风险结构化章节；步骤清单保留在文档内承载执行状态（plan-document-view.ts）。
- **构建中状态头**：executing 状态徽章升级为「构建中 · 3/5」实时进度（plan-view-model.ts）。
- **执行状态写回步骤**：新增 `plan-step-sync.ts`，executing todo 更新按「标题归一匹配 + 序号兜底、
  只推进不回退」映射到 PlanRecord 步骤（写 status/currentStepId/startedAt/completedAt）；
  turn-service 在 `plan_updated` 副作用里调用 `PlanFacade.handleExecutingUpdate`，
  只作用于 approved/executing 的计划，写回后 publishActive 让文档实时打勾。
- **审批链修复**：webview AppState 新增 `uiState`；`waiting_plan_approval` 时「开始构建/放弃」
  必须先应答 approvePlan/rejectPlan RPC，即使已有 PlanRecord（修 plan-controller.ts 的绕过 bug，
  此前 Grok 会永远等不到 exit_plan_mode 应答）。
- **修改计划 UI**：审批未决时计划文档内出现「修改意见」输入，提交走 `revisePlan(feedback)`。

## 测试与验收

- 新增测试：`tests/plan-step-sync.test.ts`（标题归一/序号兜底/只进不退/同名认领/临时条目不误伤）、
  `tests/plan-approval-chain.test.ts`（审批 RPC 应答顺序、revisePlan UI、markdown 渲染、N/M 状态头），
  均已登记 package.json。
- 运行时权限测试适配新矩阵：fake-grok 权限用例改用 medium 风险目标（package.json / npm install），
  新增低风险自动放行回归。
- 全量验收：agent-runtime typecheck/test（93/93）/build 全绿；扩展 typecheck/test（759/759）/build 全绿。

## 遗留与手工验证项

- 真实会话手工验证清单：
  1. Agent 模式改普通源码文件不再弹确认卡，改 package.json 仍弹；
  2. 已决卡片收拢成一行、变更摘要卡跨轮收拢；
  3. composer 上方任务进度条随执行刷新、点击定位；
  4. 配好两个 Provider 后跨 Provider 切模型不重连；会话中途新加的 Provider 首次切换提示重连；
  5. 长回复中离底滚动不被拉回，「回到底部」按钮可用；代码块终稿有高亮；
  6. Plan 模式生成计划后：文档正文为 markdown、审批时可提交修改意见、
     「开始构建」后 Grok 正常继续（不再悬死）、构建中状态头与步骤勾选实时更新。
- 网络隐私仍待抓包验收（见 grok-network-audit.md）。
