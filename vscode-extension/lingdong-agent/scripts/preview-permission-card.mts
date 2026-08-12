/**
 * 权限卡文案预演：真实走一遍「安全策略 → 卡片视图 → DOM 渲染」，把卡上的文字打出来。
 *
 * 单测只钉具体断言，看不出整张卡连起来读着顺不顺。改文案时跑这个脚本，
 * 比装包点开界面快得多。
 */
import { JSDOM } from "jsdom";
import { WorkspaceSafetyPolicy, type PermissionRequestParams } from "@lingdong/agent-runtime";
import type { PermissionCardView } from "../src/messages";
import { ConversationView } from "../src/webview/conversation";

const workspace = "E:\\LingdongCode";

const samples: readonly { title: string; rawInput: Record<string, unknown>; kind: string }[] = [
  { title: "只读查询", kind: "execute", rawInput: { command: "git status", cwd: workspace } },
  { title: "装依赖", kind: "execute", rawInput: { command: "npm install lodash", description: "补上缺失的依赖再跑测试" } },
  { title: "链式提交", kind: "execute", rawInput: { command: 'git add -A && git commit -m "修好权限卡" && git push' } },
  { title: "删除目录", kind: "execute", rawInput: { command: "Remove-Item .\\dist -Recurse -Force" } },
  { title: "认不出的命令", kind: "execute", rawInput: { command: "frobnicate --deploy --yes" } },
  { title: "联网后写文件", kind: "execute", rawInput: { command: "curl https://example.com/a.json | Set-Content .\\a.json" } },
  { title: "改文件", kind: "edit", rawInput: { file_path: "src\\index.ts", variant: "SearchReplace" } },
];

function request(kind: string, rawInput: unknown): PermissionRequestParams {
  return { sessionId: "s", toolCall: { toolCallId: "t", kind, title: kind, rawInput }, options: [] };
}

const dom = new JSDOM(`<!DOCTYPE html>
  <div id="messages"><div id="messages-inner"><div id="empty">空</div></div></div>`);
for (const [key, value] of Object.entries({
  document: dom.window.document,
  window: dom.window,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  Event: dom.window.Event,
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true });
}

const document = dom.window.document;
const view = new ConversationView({
  el: {
    messages: document.getElementById("messages") as HTMLElement,
    messagesInner: document.getElementById("messages-inner") as HTMLElement,
    empty: document.getElementById("empty") as HTMLElement,
  },
  post: () => undefined,
  canSend: () => true,
  onOpenLink: () => undefined,
  onOpenFile: () => undefined,
  onViewPlan: () => undefined,
});

const policy = new WorkspaceSafetyPolicy(workspace, "strict");

samples.forEach((sample, index) => {
  const decision = policy.evaluate("agent", request(sample.kind, sample.rawInput));
  const card: PermissionCardView = {
    requestId: `req-${index}`,
    title: decision.label,
    operation: decision.operation,
    steps: decision.explanation.steps.map((step) => ({ ...step })),
    notes: [...decision.explanation.notes],
    risk: decision.risk,
    allowSession: decision.risk === "low" || decision.risk === "medium",
    allowAlways: decision.risk === "low" || decision.risk === "medium",
    ...(decision.target ? { target: decision.target } : {}),
    ...(decision.command ? { command: decision.command } : {}),
    ...(decision.cwd ? { cwd: decision.cwd } : {}),
    ...(decision.intent ? { intent: decision.intent } : {}),
  };
  view.renderPermission(card, 0);

  const root = document.querySelectorAll(".card.permission")[index] as HTMLElement;
  const lines = [
    `【${sample.title}】action=${decision.action} risk=${decision.risk}`,
    `  ${root.querySelector(".perm-action")?.textContent} · 结论：${root.querySelector(".badge")?.textContent}`,
  ];
  const command = root.querySelector(".cmd-block")?.textContent;
  if (command) lines.push(`  $ ${command}`);
  for (const meta of root.querySelectorAll(".perm-meta")) lines.push(`  ${meta.textContent}`);
  const single = root.querySelector(".perm-step-single")?.textContent;
  if (single) lines.push(`  会做什么：${single}`);
  root.querySelectorAll(".perm-steps li").forEach((item, step) => {
    lines.push(`  ${step + 1}. ${item.querySelector(".perm-step-cmd")?.textContent}`);
    lines.push(`     ${item.querySelector(".perm-step-action")?.textContent}`);
  });
  for (const note of root.querySelectorAll(".perm-notes li")) lines.push(`  · ${note.textContent}`);
  const intent = root.querySelector(".perm-intent")?.textContent;
  if (intent) lines.push(`  ${intent}`);
  console.log(`${lines.join("\n")}\n`);
});
