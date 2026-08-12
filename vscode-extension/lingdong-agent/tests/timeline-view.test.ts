import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { ActivityGroupHeader } from "../src/presentation/activity-group";
import type { ActivityItem } from "../src/presentation/activity-item";
import type { TurnPresentation, TurnPresentationHeader } from "../src/presentation/turn-presentation";
import { DurationClock } from "../src/webview/timeline/duration-view";
import { TimelineView } from "../src/webview/timeline/timeline-view";

/** 每个用例独立的 DOM，避免节点在用例之间串味。 */
function installDom(): Document {
  const dom = new JSDOM(`<!DOCTYPE html><div id="host"></div>`);
  const { window } = dom;
  for (const [key, value] of Object.entries({
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    Event: window.Event,
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  return window.document;
}

interface Harness {
  document: Document;
  host: HTMLElement;
  view: TimelineView;
  clock: DurationClock;
  logs: number;
}

function createHarness(): Harness {
  const document = installDom();
  const host = document.getElementById("host") as HTMLElement;
  const clock = new DurationClock();
  const harness = { document, host, clock, logs: 0 } as Harness;
  harness.view = new TimelineView({
    mount: (node) => host.appendChild(node),
    onShowLog: () => { harness.logs += 1; },
  }, clock);
  return harness;
}

function turn(overrides: Partial<TurnPresentationHeader> = {}): TurnPresentationHeader {
  return { sessionId: "s1", turnId: "t1", status: "running", startedAt: 0, ...overrides };
}

function group(overrides: Partial<ActivityGroupHeader> = {}): ActivityGroupHeader {
  return {
    id: "g1",
    kind: "exploration",
    title: "探索代码库",
    status: "running",
    startedAt: 0,
    ...overrides,
  };
}

function item(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "i1",
    toolCallId: "c1",
    action: "read",
    target: "src/a.ts",
    status: "running",
    startedAt: 0,
    ...overrides,
  };
}

test("每个 turnId 只挂载一个时间线节点", () => {
  const { view, host } = createHarness();
  view.applyTurn(turn());
  view.applyTurn(turn({ status: "completed", completedAt: 5_000, durationMs: 5_000 }));
  view.applyGroup("t1", group());

  assert.equal(host.querySelectorAll("section.timeline").length, 1);
  assert.equal(view.turnCount, 1);
});

test("运行中的组默认折叠；用户展开后可看条目，终态保持折叠", () => {
  const { view } = createHarness();
  view.applyTurn(turn());
  view.applyGroup("t1", group());
  view.applyItem("t1", "g1", item());

  const node = view.groupNode("t1", "g1");
  assert.ok(node);
  assert.equal(node.open, false, "默认折叠，不直接露底层工具名");
  assert.equal(node.renderedItemCount, 0, "折叠时不创建条目 DOM");

  node.root.open = true;
  node.root.dispatchEvent(new globalThis.Event("toggle"));
  assert.equal(node.renderedItemCount, 1, "展开时惰性创建条目 DOM");

  view.applyItem("t1", "g1", item({ status: "completed", completedAt: 50 }));
  view.applyGroup("t1", group({ status: "completed", completedAt: 60 }));
  assert.equal(node.open, false, "组进入终态后收拢成一行摘要");
  assert.equal(node.renderedItemCount, 0, "收拢后释放条目 DOM");

  // 用户重新展开已完成的组，后续头部更新不得把它再合上。
  node.root.open = true;
  node.root.dispatchEvent(new globalThis.Event("toggle"));
  assert.equal(node.renderedItemCount, 1, "展开时惰性重建条目 DOM");
  view.applyGroup("t1", group({ status: "completed", completedAt: 60 }));
  assert.equal(node.open, true, "非「运行中→终态」的更新不改变展开状态");
});

test("运行中命令的实时输出挂在 summary 内，折叠时也看得见", () => {
  const { view } = createHarness();
  view.applyTurn(turn());
  view.applyGroup("t1", group({ kind: "command", title: "执行命令" }));
  view.applyItem("t1", "g1", item({ action: "run", target: "npm test", outputTail: "line 7" }));

  const node = view.groupNode("t1", "g1");
  assert.ok(node);
  assert.equal(node.open, false);

  const output = node.root.querySelector<HTMLElement>(".tl-group-output");
  assert.ok(output);
  assert.equal(output.hidden, false);
  assert.equal(output.textContent, "line 7");
  // details 折叠时只渲染 summary，输出落在 summary 之外就等于「展开才可见」。
  assert.equal(output.closest("summary")?.className, "tl-group-head", "实时输出必须在 summary 内");

  view.applyItem("t1", "g1", item({ action: "run", target: "npm test", outputTail: "line 8" }));
  assert.equal(node.root.querySelector(".tl-group-output"), output, "刷新尾巴不得替换节点");
  assert.equal(output.textContent, "line 8");

  // 命令收尾后尾巴清空，输出块自己隐藏。
  view.applyItem("t1", "g1", item({ action: "run", target: "npm test", status: "completed", completedAt: 20 }));
  assert.equal(output.hidden, true);
});

test("恢复的历史组保持折叠，展开后才创建条目 DOM，折叠时释放", () => {
  const { view } = createHarness();
  view.applyTurn(turn({ status: "completed", completedAt: 100, durationMs: 100 }));
  view.applyGroup("t1", group({ status: "completed", completedAt: 90 }));
  view.applyItem("t1", "g1", item({ status: "completed", completedAt: 80 }));

  const node = view.groupNode("t1", "g1");
  assert.ok(node);
  assert.equal(node.open, false, "带终态到达的组默认折叠");
  assert.equal(node.renderedItemCount, 0, "折叠状态下不应有条目 DOM");

  node.root.open = true;
  node.root.dispatchEvent(new globalThis.Event("toggle"));
  assert.equal(node.renderedItemCount, 1);

  node.root.open = false;
  node.root.dispatchEvent(new globalThis.Event("toggle"));
  assert.equal(node.renderedItemCount, 0, "折叠后应释放详情 DOM");
});

test("标题行显示当前条目文案，条目结束或组收尾后消失", () => {
  const { view } = createHarness();
  view.applyTurn(turn());
  view.applyGroup("t1", group({ kind: "editing", title: "修改代码" }));
  view.applyItem("t1", "g1", item({ action: "edit", target: "src/foo.ts" }));

  const node = view.groupNode("t1", "g1");
  assert.ok(node);
  const current = node.root.querySelector<HTMLElement>(".tl-group-current");
  assert.ok(current);
  assert.equal(current.hidden, false);
  assert.match(current.textContent ?? "", /正在修改 src\/foo\.ts/);

  // 第二个条目开始后，标题行跟到最新的一条。
  view.applyItem("t1", "g1", item({ status: "completed", completedAt: 10 }));
  view.applyItem("t1", "g1", item({ id: "i2", toolCallId: "c2", action: "create", target: "src/bar.ts" }));
  assert.match(current.textContent ?? "", /正在创建 src\/bar\.ts/);

  view.applyItem("t1", "g1", item({ id: "i2", toolCallId: "c2", action: "create", target: "src/bar.ts", status: "completed", completedAt: 20 }));
  assert.equal(current.hidden, true, "没有运行中的条目就不显示当前文案");
});

test("轮次终态兜底：没收到收尾消息的组也被收拢", () => {
  const { view } = createHarness();
  view.applyTurn(turn());
  view.applyGroup("t1", group());
  view.applyItem("t1", "g1", item());

  const node = view.groupNode("t1", "g1");
  assert.ok(node);
  node.root.open = true;
  node.root.dispatchEvent(new globalThis.Event("toggle"));
  assert.equal(node.open, true);

  view.applyTurn(turn({ status: "stopped", completedAt: 900, durationMs: 900 }));
  assert.equal(node.open, false, "轮次终态时残留的运行中组必须收拢");
});

test("新事件只更新对应条目，已有条目 DOM 保持同一实例", () => {
  const { view } = createHarness();
  view.applyTurn(turn());
  view.applyGroup("t1", group());
  view.applyItem("t1", "g1", item());
  view.applyItem("t1", "g1", item({ id: "i2", toolCallId: "c2", target: "src/b.ts" }));

  const node = view.groupNode("t1", "g1");
  assert.ok(node);
  node.root.open = true;
  node.root.dispatchEvent(new globalThis.Event("toggle"));

  const first = node.root.querySelector('[data-item-id="i1"]');
  const second = node.root.querySelector('[data-item-id="i2"]');
  assert.ok(first && second);

  view.applyItem("t1", "g1", item({ status: "completed", completedAt: 100 }));

  assert.equal(node.root.querySelector('[data-item-id="i1"]'), first, "同一条目必须原地更新");
  assert.equal(node.root.querySelector('[data-item-id="i2"]'), second, "无关条目不得重建");
  assert.equal(node.renderedItemCount, 2);
  assert.match(first.textContent ?? "", /已读取 src\/a\.ts/);
});

test("界面不出现任何原始工具名", () => {
  const { view, host } = createHarness();
  view.applyTurn(turn());
  view.applyGroup("t1", group());
  view.applyItem("t1", "g1", item({ status: "completed", completedAt: 10 }));
  view.applyGroup("t1", group({ id: "g2", kind: "command", title: "执行命令" }));
  view.applyItem("t1", "g2", item({ id: "i2", toolCallId: "c2", action: "run", target: "npm run dev" }));

  for (const node of Array.from(host.querySelectorAll<HTMLDetailsElement>("details.tl-group"))) {
    node.open = true;
    node.dispatchEvent(new globalThis.Event("toggle"));
  }
  const text = host.textContent ?? "";
  for (const forbidden of ["tool_started", "tool_completed", "Read", "List Files", "Run Command"]) {
    assert.ok(!text.includes(forbidden), `不应出现原始事件名 ${forbidden}`);
  }
  assert.match(text, /探索代码库/);
});

test("运行中的组订阅计时，进入终态后停表", () => {
  const { view, clock } = createHarness();
  view.applyTurn(turn());
  view.applyGroup("t1", group());
  assert.equal(clock.running, true);
  assert.equal(clock.subscriberCount, 1);

  view.applyGroup("t1", group({ status: "completed", completedAt: 8_000 }));
  assert.equal(clock.subscriberCount, 0);
  assert.equal(clock.running, false, "没有运行中的组就必须停表");
});

test("计时只改文本节点，不重建 DOM", () => {
  const { view, clock } = createHarness();
  view.applyTurn(turn({ startedAt: Date.now() - 3_000 }));
  view.applyGroup("t1", group({ startedAt: Date.now() - 3_000 }));

  const node = view.groupNode("t1", "g1");
  assert.ok(node);
  const durationNode = node.root.querySelector(".tl-group-duration");
  assert.ok(durationNode);
  assert.match(durationNode.textContent ?? "", /已运行/);

  clock.tick();
  assert.equal(node.root.querySelector(".tl-group-duration"), durationNode, "计时不得替换节点");
});

test("轮次进入终态后即使组没收到收尾消息也强制停表", () => {
  const { view, clock } = createHarness();
  view.applyTurn(turn());
  view.applyGroup("t1", group());
  assert.equal(clock.running, true);

  view.applyTurn(turn({ status: "failed", completedAt: 9_000, durationMs: 9_000 }));
  assert.equal(clock.running, false);
});

test("失败条目提供输出面板入口", () => {
  const harness = createHarness();
  const { view } = harness;
  view.applyTurn(turn());
  view.applyGroup("t1", group({ kind: "command", title: "执行命令" }));
  view.applyItem("t1", "g1", item({
    action: "run",
    target: "npm run bad",
    status: "failed",
    completedAt: 20,
    exitCode: 1,
    detail: "command not found",
  }));

  const node = view.groupNode("t1", "g1");
  assert.ok(node);
  node.root.open = true;
  node.root.dispatchEvent(new globalThis.Event("toggle"));

  const button = node.root.querySelector<HTMLButtonElement>(".tl-item-log");
  assert.ok(button);
  button.click();
  assert.equal(harness.logs, 1);
  assert.match(node.root.textContent ?? "", /退出码 1/);
});

test("终态提示按状态给出解释，完成时不加噪声", () => {
  const cases: Array<[TurnPresentationHeader["status"], RegExp | undefined]> = [
    ["completed", undefined],
    ["stopped", /已按你的要求停止/],
    ["interrupted", /扩展重启而中断/],
    ["failed", /未能完成/],
  ];
  for (const [status, expected] of cases) {
    const { view, host } = createHarness();
    view.applyTurn(turn({ status, completedAt: 1_000, durationMs: 1_000 }));
    const hint = host.querySelector<HTMLElement>(".tl-hint");
    assert.ok(hint);
    if (expected) assert.match(hint.textContent ?? "", expected);
    else assert.equal(hint.hidden, true, "正常完成不显示额外提示");
  }
});

test("恢复历史时间线铺出终态且不订阅计时", () => {
  const { view, host, clock } = createHarness();
  const presentation: TurnPresentation = {
    sessionId: "s1",
    turnId: "t9",
    status: "completed",
    startedAt: 0,
    completedAt: 359_000,
    durationMs: 359_000,
    summary: { filesRead: 5, searches: 2, filesModified: 3, verificationStatus: "passed", testsPassed: 296 },
    groups: [
      {
        id: "g1",
        kind: "exploration",
        title: "探索代码库",
        status: "completed",
        startedAt: 0,
        completedAt: 8_000,
        items: [item({ status: "completed", completedAt: 8_000 })],
      },
      {
        id: "g2",
        kind: "verification",
        title: "验证结果",
        status: "completed",
        startedAt: 9_000,
        completedAt: 20_000,
        items: [item({ id: "i2", toolCallId: "c2", action: "test", target: "npm test", status: "completed", completedAt: 20_000 })],
      },
    ],
  };
  view.restore(presentation);

  assert.equal(host.querySelectorAll(".tl-group").length, 2);
  assert.equal(clock.running, false, "历史时间线不得订阅实时更新");

  const summary = host.querySelector<HTMLElement>(".tl-summary-stats");
  assert.match(summary?.textContent ?? "", /查看 5 个文件/);
  assert.match(summary?.textContent ?? "", /296 项通过/);
  assert.ok(!/[+-]\d/.test(summary?.textContent ?? ""), "没有可靠行数时不显示 +N/-N");
  assert.match(host.querySelector<HTMLElement>(".tl-summary-duration")?.textContent ?? "", /耗时 5 分 59 秒/);
});

test("条目上的行数跟在路径后面显示 +N/-N", () => {
  const { view } = createHarness();
  view.applyTurn(turn());
  view.applyGroup("t1", group({ kind: "editing", title: "修改代码" }));
  view.applyItem("t1", "g1", item({
    action: "edit",
    target: "src/app.ts",
    lines: { added: 12, deleted: 3 },
    status: "completed",
    completedAt: 100,
  }));

  const node = view.groupNode("t1", "g1");
  assert.ok(node);
  node.root.open = true;
  node.root.dispatchEvent(new globalThis.Event("toggle"));
  assert.match(node.root.textContent ?? "", /src\/app\.ts \+12 -3/);
});

test("结算行给出本轮行数合计", () => {
  const { view, host } = createHarness();
  view.applyTurn(turn({
    status: "completed",
    completedAt: 2_000,
    durationMs: 2_000,
    summary: { filesModified: 2, addedLines: 40, deletedLines: 7 },
  }));
  view.applyGroup("t1", group({ kind: "editing", title: "修改代码" }));
  view.applyGroup("t1", group({ id: "g2", kind: "verification", title: "验证结果" }));

  assert.match(host.querySelector<HTMLElement>(".tl-summary-stats")?.textContent ?? "", /\+40 -7/);
});

test("统计为空时隐藏结算行，不显示空壳", () => {
  const { view, host } = createHarness();
  view.applyTurn(turn({ status: "completed", completedAt: 1_000, durationMs: 1_000 }));
  const stats = host.querySelector<HTMLElement>(".tl-summary-stats");
  assert.ok(stats);
  assert.equal(stats.hidden, true);
});

test("状态只说一次：终态分组头不报已完成/耗时，结算行是唯一出处", () => {
  const { view, host } = createHarness();
  view.applyTurn(turn({
    status: "completed",
    completedAt: 5_000,
    durationMs: 5_000,
    summary: { commandsRun: 1 },
  }));
  view.applyGroup("t1", group({
    kind: "command",
    title: "执行命令",
    status: "completed",
    startedAt: 0,
    completedAt: 5_000,
  }));
  view.applyItem("t1", "g1", item({
    action: "run",
    target: "ls",
    status: "completed",
    completedAt: 5_000,
  }));

  const summary = host.querySelector<HTMLElement>(".tl-summary");
  assert.ok(summary);
  assert.equal(summary.hidden, false, "终态后结算行必须出现（单组也一样）");
  assert.match(host.querySelector(".tl-summary-status")?.textContent ?? "", /已完成/);

  const groupStats = host.querySelector<HTMLElement>(".tl-group-stats");
  assert.ok(groupStats);
  assert.equal(groupStats.hidden, true, "终态分组不再重复写「执行 N 条命令」");

  assert.match(host.querySelector(".tl-group-title")?.textContent ?? "", /执行命令/);
  const groupDuration = host.querySelector<HTMLElement>(".tl-group-duration");
  const groupStatus = host.querySelector<HTMLElement>(".tl-group-status");
  assert.equal(groupDuration?.hidden, true, "终态分组不再逐组报耗时");
  assert.equal(groupStatus?.hidden, true, "终态分组不再重复「已完成」");
});

test("运行中的轮次不挂结算行，失败的分组保留状态标记", () => {
  const { view, host } = createHarness();
  view.applyTurn(turn({ status: "running", summary: { commandsRun: 1 } }));
  view.applyGroup("t1", group({ kind: "command", title: "执行命令", status: "running", startedAt: 0 }));

  const summary = host.querySelector<HTMLElement>(".tl-summary");
  assert.equal(summary?.hidden, true, "运行中各组自己在计时，结算行不该出现");
  assert.equal(host.querySelector<HTMLElement>(".tl-group-duration")?.hidden, false, "运行中的组要滚动计时");

  view.applyGroup("t1", group({
    kind: "command",
    title: "执行命令",
    status: "failed",
    startedAt: 0,
    completedAt: 2_000,
  }));
  const groupStatus = host.querySelector<HTMLElement>(".tl-group-status");
  assert.equal(groupStatus?.hidden, false, "失败必须标在出事的分组上");
  assert.match(groupStatus?.textContent ?? "", /失败/);
});

test("重试给上一轮打标记且保留历史", () => {
  const { view, host } = createHarness();
  view.applyTurn(turn({ turnId: "t1", status: "completed", completedAt: 1_000, durationMs: 1_000 }));
  view.markPreviousRetried();

  assert.equal(host.querySelectorAll("section.timeline").length, 1);
  assert.match(host.querySelector<HTMLElement>(".tl-summary-status")?.textContent ?? "", /已重试/);

  view.applyTurn(turn({ turnId: "t2" }));
  assert.equal(view.turnCount, 2, "新一轮独立成节点，旧时间线不删除");
});

test("clear 释放全部节点并停表", () => {
  const { view, clock } = createHarness();
  view.applyTurn(turn());
  view.applyGroup("t1", group());
  assert.equal(clock.running, true);

  view.clear();
  assert.equal(view.turnCount, 0);
  assert.equal(clock.running, false);
});
