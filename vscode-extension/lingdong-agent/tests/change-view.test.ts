import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTurn, ChangeKind, ChangeStatus, ChangedFile, TurnStatus } from "../src/change-tracker";
import { toChangeList } from "../src/change-view";

function file(
  relativePath: string,
  kind: ChangeKind,
  status: ChangeStatus,
  extra: Partial<ChangedFile> = {},
): ChangedFile {
  return {
    id: `chg-${relativePath}`,
    turnId: "turn-1-abcd",
    relativePath,
    absolutePath: `E:\\ws\\${relativePath}`,
    kind,
    beforeSha256: "before",
    afterSha256: "after",
    size: 1,
    status,
    restorable: true,
    updatedAt: 0,
    ...extra,
  };
}

function turn(changedFiles: ChangedFile[], status: TurnStatus = "completed"): AgentTurn {
  return {
    turnId: "turn-1-abcd",
    sessionId: "s1",
    index: 3,
    startedAt: 0,
    mode: "agent",
    prompt: "改标题",
    contextLabels: [],
    changedFiles,
    status,
  };
}

test("变更列表显示数量、字母标记与中文状态", () => {
  const view = toChangeList(turn([
    file("index.html", "modify", "pending"),
    file("style.css", "modify", "accepted"),
    file("src/Feature.ts", "create", "pending"),
  ]));

  assert.equal(view.title, "本轮修改了 3 个文件");
  assert.equal(view.turnIndex, 3);
  assert.equal(view.statusLabel, "已完成");
  assert.deepEqual(view.rows.map((row) => row.letter), ["M", "M", "A"]);
  assert.deepEqual(view.rows.map((row) => row.statusLabel), ["待处理", "已接受", "待处理"]);
  assert.equal(view.pending, 2);
  assert.equal(view.accepted, 1);
  assert.equal(view.canAcceptAll, true);
  assert.equal(view.canRejectAll, true);
  assert.equal(view.canUndo, true);
});

test("删除与重命名有独立字母，重命名带原路径", () => {
  const view = toChangeList(turn([
    file("old.txt", "delete", "pending"),
    file("new-name.txt", "rename", "pending", { previousRelativePath: "old-name.txt" }),
  ]));
  assert.deepEqual(view.rows.map((row) => row.letter), ["D", "R"]);
  assert.equal(view.rows[1]?.previousRelativePath, "old-name.txt");
  assert.equal(view.rows[1]?.kindLabel, "重命名");
});

test("全部处理完成后不能再接受或撤销", () => {
  const view = toChangeList(turn([
    file("a.txt", "modify", "accepted"),
    file("b.txt", "modify", "restored"),
  ], "restored"));
  assert.equal(view.pending, 0);
  assert.equal(view.canAcceptAll, false);
  assert.equal(view.canRejectAll, false);
  assert.equal(view.canUndo, false);
  assert.equal(view.statusLabel, "已全部恢复");
});

test("冲突文件不进接受全部，但仍可触发撤销再判一次", () => {
  const view = toChangeList(turn([
    file("index.html", "modify", "conflict", { conflictReason: "文件已在 Agent 修改后发生其他变化，不能安全自动恢复" }),
  ], "partially_restored"));
  assert.equal(view.conflicts, 1);
  assert.equal(view.canAcceptAll, false);
  assert.equal(view.canUndo, true);
  assert.equal(view.rows[0]?.statusLabel, "有冲突");
  assert.match(view.rows[0]?.conflictReason ?? "", /不能安全自动恢复/);
  assert.equal(view.statusLabel, "部分恢复");
});

test("取消的轮次同样展示已经产生的修改", () => {
  const view = toChangeList(turn([file("index.html", "modify", "pending")], "cancelled"));
  assert.equal(view.statusLabel, "已停止");
  assert.equal(view.rows.length, 1);
  assert.equal(view.canUndo, true);
});

test("有行级统计的文件带上 +N/-N，并汇总到整轮", () => {
  const stats = new Map([
    ["index.html", { added: 12, deleted: 3 }],
    ["style.css", { added: 5, deleted: 0 }],
  ]);
  const view = toChangeList(
    turn([
      file("index.html", "modify", "pending"),
      file("style.css", "modify", "pending"),
      // 命令改出来的文件没有 file_diff，拿不到行数。
      file("build/out.js", "create", "pending"),
    ]),
    (_turnId, path) => stats.get(path),
  );

  assert.deepEqual(view.rows[0]?.lines, { added: 12, deleted: 3 });
  assert.equal(view.rows[2]?.lines, undefined, "算不出来就不给，不补零");
  assert.deepEqual(view.lines, { added: 17, deleted: 3 });
});

test("一个文件都没有行数时整轮也不给合计", () => {
  const view = toChangeList(turn([file("index.html", "modify", "pending")]), () => undefined);
  assert.equal(view.lines, undefined);
  assert.equal(view.rows[0]?.lines, undefined);
});

test("行数按轮次核对，不会把这一轮的数字贴到别的轮次", () => {
  const seen: string[] = [];
  toChangeList(turn([file("index.html", "modify", "pending")]), (turnId) => {
    seen.push(turnId);
    return undefined;
  });
  assert.deepEqual(seen, ["turn-1-abcd"]);
});

test("没有文件修改时列表为空且没有可用操作", () => {
  const view = toChangeList(turn([]));
  assert.equal(view.title, "本轮修改了 0 个文件");
  assert.equal(view.rows.length, 0);
  assert.equal(view.canUndo, false);
});
