import assert from "node:assert/strict";
import test from "node:test";
import type { ChangeKind, ChangedFile } from "../src/change-tracker";
import {
  SNAPSHOT_SCHEME,
  buildSnapshotUri,
  diffTitle,
  parseSnapshotUri,
  planDiff,
} from "../src/diff-model";

function change(kind: ChangeKind, relativePath: string, extra: Partial<ChangedFile> = {}): ChangedFile {
  return {
    id: "chg-1",
    turnId: "turn-1-abcd",
    relativePath,
    absolutePath: `E:\\ws\\${relativePath.replace(/\//g, "\\")}`,
    kind,
    beforeSha256: "before",
    afterSha256: "after",
    size: 10,
    status: "pending",
    restorable: true,
    updatedAt: 0,
    ...extra,
  };
}

test("快照 URI 使用独立 scheme，定位信息放在 query 里", () => {
  const parts = buildSnapshotUri("turn-1-abcd", "src/app.ts");
  assert.equal(parts.scheme, SNAPSHOT_SCHEME);
  assert.equal(parts.path, "/src/app.ts");
  assert.deepEqual(parseSnapshotUri(parts), {
    turnId: "turn-1-abcd",
    relativePath: "src/app.ts",
    empty: false,
  });
});

test("中文、空格与井号路径能原样往返", () => {
  for (const relativePath of ["模板/首页 说明.html", "docs/a#b.md", "带 空格/子 目录/文件.txt"]) {
    const parts = buildSnapshotUri("turn-2-ef01", relativePath);
    assert.equal(parseSnapshotUri(parts)?.relativePath, relativePath);
  }
});

test("Windows 反斜杠与前导 ./ 会被规范化", () => {
  const parts = buildSnapshotUri("turn-3-1111", ".\\src\\webview\\main.ts");
  assert.equal(parts.path, "/src/webview/main.ts");
  assert.equal(parseSnapshotUri(parts)?.relativePath, "src/webview/main.ts");
});

test("空文档标记与非法 query 都能识别", () => {
  const empty = buildSnapshotUri("turn-4-2222", "new.ts", true);
  assert.equal(parseSnapshotUri(empty)?.empty, true);
  assert.equal(parseSnapshotUri({ query: "" }), undefined);
  assert.equal(parseSnapshotUri({ query: "turn=turn-4-2222" }), undefined);
  assert.equal(parseSnapshotUri({ query: "path=index.html" }), undefined);
});

test("Diff 标题包含文件名、轮次与两侧含义", () => {
  assert.equal(
    diffTitle({ relativePath: "index.html", turnIndex: 2, kind: "modify" }),
    "index.html（第 2 轮：修改前 ↔ 当前）",
  );
  assert.equal(
    diffTitle({ relativePath: "src/new.ts", turnIndex: 1, kind: "create" }),
    "新建 src/new.ts（第 1 轮）",
  );
  assert.equal(
    diffTitle({ relativePath: "old.txt", turnIndex: 3, kind: "delete" }),
    "删除 old.txt（第 3 轮：修改前）",
  );
  assert.equal(
    diffTitle({ relativePath: "new.txt", turnIndex: 4, kind: "rename", previousRelativePath: "old.txt" }),
    "重命名 old.txt → new.txt（第 4 轮）",
  );
});

test("修改类变更走左右 Diff", () => {
  const plan = planDiff(change("modify", "index.html"), 1);
  assert.equal(plan.mode, "diff");
  if (plan.mode !== "diff") return;
  assert.deepEqual(plan.left, {
    kind: "snapshot",
    turnId: "turn-1-abcd",
    relativePath: "index.html",
    empty: false,
  });
  assert.deepEqual(plan.right, { kind: "file", absolutePath: "E:\\ws\\index.html" });
});

test("新建文件走单栏，不再用空左侧 Diff", () => {
  const plan = planDiff(change("create", "src/new.ts"), 1);
  assert.equal(plan.mode, "single");
  if (plan.mode !== "single") return;
  assert.deepEqual(plan.side, { kind: "file", absolutePath: "E:\\ws\\src\\new.ts" });
});

test("修改但无快照时走单栏，避免左侧斜纹空栏", () => {
  const plan = planDiff(change("modify", "brief.md", { restorable: false, beforeSha256: "" }), 1);
  assert.equal(plan.mode, "single");
  if (plan.mode !== "single") return;
  assert.deepEqual(plan.side, { kind: "file", absolutePath: "E:\\ws\\brief.md" });
});

test("删除文件走单栏快照，不再用空右侧 Diff", () => {
  const plan = planDiff(change("delete", "old.txt"), 5);
  assert.equal(plan.mode, "single");
  if (plan.mode !== "single") return;
  assert.deepEqual(plan.side, {
    kind: "snapshot",
    turnId: "turn-1-abcd",
    relativePath: "old.txt",
    empty: false,
  });
});

test("重命名左侧取原路径的快照，标题带两个路径", () => {
  const plan = planDiff(change("rename", "new-name.txt", { previousRelativePath: "old-name.txt" }), 2);
  assert.equal(plan.mode, "diff");
  if (plan.mode !== "diff") return;
  assert.equal(plan.left.kind === "snapshot" && plan.left.relativePath, "old-name.txt");
  assert.equal(plan.right.kind, "file");
  assert.match(plan.title, /old-name\.txt → new-name\.txt/);
});
