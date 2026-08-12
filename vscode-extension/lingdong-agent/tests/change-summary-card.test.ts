import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { ChangeListView } from "../src/change-view";
import type { DiffText } from "../src/diff-text";
import { fillChangeSummaryCard, type ChangeSummaryOptions } from "../src/webview/change-summary-card";
import { renderDiffText } from "../src/webview/diff-render";

function installDom(): Document {
  const dom = new JSDOM("<!DOCTYPE html><div id=\"root\"></div>");
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "Event", { value: dom.window.Event, configurable: true });
  return dom.window.document;
}

function view(overrides: Partial<ChangeListView> = {}): ChangeListView {
  return {
    turnId: "turn-1",
    turnIndex: 1,
    title: "本轮修改了 1 个文件",
    status: "completed",
    statusLabel: "已完成",
    rows: [
      {
        changeId: "chg-1",
        relativePath: "docs/a.md",
        kind: "create",
        letter: "A",
        kindLabel: "新建",
        status: "pending",
        statusLabel: "待处理",
        restorable: true,
        lines: { added: 12, deleted: 3 },
      },
    ],
    pending: 1,
    accepted: 0,
    restored: 0,
    conflicts: 0,
    canAcceptAll: true,
    canRejectAll: true,
    canUndo: true,
    lines: { added: 12, deleted: 3 },
    ...overrides,
  };
}

function options(overrides: Partial<ChangeSummaryOptions> = {}): ChangeSummaryOptions {
  return { canApply: true, canRestore: true, onOpenChange: () => {}, ...overrides };
}

test("摘要卡是紧凑形态：头部文件数 + 合计行数 + Review，行内没有操作链接", () => {
  const document = installDom();
  const card = document.createElement("section");
  card.className = "card change-summary";

  fillChangeSummaryCard(card, view(), options(), () => {});

  assert.match(card.querySelector(".card-title")?.textContent ?? "", /1 个文件已修改/);
  assert.equal(card.querySelector(".change-summary-header .diff-added")?.textContent, "+12");
  assert.ok(card.querySelector(".change-summary-review"), "头部要有 Review 入口");
  // 行内瘦身：不再有 展开 / Diff / 逐项接受拒绝。
  const labels = [...card.querySelectorAll("button")].map((b) => b.textContent);
  assert.ok(!labels.includes("展开"));
  assert.ok(!labels.includes("Diff"));
  assert.ok(!labels.includes("接受"));
  // 批量操作仍在。
  assert.ok(labels.includes("接受全部"));
});

test("点文件行与 Review 都走右栏回调，不再直接开编辑器", () => {
  const document = installDom();
  const card = document.createElement("section");
  const posted: unknown[] = [];
  const opened: Array<string | undefined> = [];
  fillChangeSummaryCard(card, view(), options({ onOpenChange: (id) => opened.push(id) }), (message) => {
    posted.push(message);
  });

  card.querySelector<HTMLButtonElement>(".change-summary-row")?.click();
  card.querySelector<HTMLButtonElement>(".change-summary-review")?.click();
  assert.deepEqual(opened, ["chg-1", "chg-1"]);
  assert.deepEqual(posted, [], "点击行不得发 openDiff 等宿主消息");
});

test("行内只在冲突或终态时出现小状态字，待处理不重复念状态", () => {
  const document = installDom();
  const card = document.createElement("section");
  fillChangeSummaryCard(card, view(), options(), () => {});
  assert.equal(card.querySelector(".change-summary-flag"), null);

  const conflicted = view({
    rows: [{ ...view().rows[0]!, status: "conflict", statusLabel: "有冲突" }],
  });
  fillChangeSummaryCard(card, conflicted, options(), () => {});
  assert.equal(card.querySelector(".change-summary-flag.reject")?.textContent, "冲突");
});

function diffText(overrides: Partial<DiffText> = {}): DiffText {
  return {
    added: 1,
    removed: 1,
    degraded: false,
    omittedHunks: 0,
    hunks: [
      {
        header: "@@ -1,2 +1,2 @@",
        lines: [
          { kind: "ctx", text: "hello", oldLine: 1, newLine: 1 },
          { kind: "del", text: "old", oldLine: 2 },
          { kind: "add", text: "new", newLine: 2 },
        ],
      },
    ],
    ...overrides,
  };
}

test("diff 渲染按 +/- 着色并带行号，超出的 hunk 给出兜底提示", () => {
  const document = installDom();
  const body = document.createElement("div");
  renderDiffText(body, diffText({ omittedHunks: 2 }));

  const lines = [...body.querySelectorAll(".change-diff-line")];
  assert.deepEqual(
    lines.map((line) => line.className),
    ["change-diff-line diff-ctx", "change-diff-line diff-del", "change-diff-line diff-add"],
  );
  assert.equal(body.querySelector(".change-diff-header")?.textContent, "@@ -1,2 +1,2 @@");
  assert.equal(body.querySelector(".diff-added")?.textContent, "+1");
  assert.ok(body.textContent?.includes("还有 2 处改动"));
});

test("空 diff 明确说内容没有变化，不留空壳", () => {
  const document = installDom();
  const body = document.createElement("div");
  renderDiffText(body, diffText({ hunks: [], added: 0, removed: 0 }));
  assert.match(body.textContent ?? "", /内容没有变化/);
});
