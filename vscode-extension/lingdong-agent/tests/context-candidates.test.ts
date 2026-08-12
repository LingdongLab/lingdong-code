import assert from "node:assert/strict";
import test from "node:test";
import {
  RECENT_LIMIT,
  WORKSPACE_LIMIT,
  buildSuggestions,
  readMentionQuery,
  scoreCandidate,
  selectableCandidates,
  truncationHint,
  type ContextCandidate,
} from "../src/composer/context-candidate";

function fileCandidate(relativePath: string, group: "recent" | "workspace" = "workspace"): ContextCandidate {
  return {
    id: `c-${relativePath}`,
    source: "file",
    label: relativePath.split("/").pop() ?? relativePath,
    detail: relativePath,
    group,
  };
}

const QUICK: ContextCandidate[] = [
  { id: "q-current-file", source: "current-file", label: "当前文件", detail: "src/app.ts", group: "quick" },
  { id: "q-selection", source: "selection", label: "选中代码", group: "quick", disabledReason: "当前没有选中内容" },
  { id: "q-problems", source: "problems", label: "问题面板 (3)", group: "quick" },
];

test("空查询返回三组候选，快捷项保持固定顺序", () => {
  const result = buildSuggestions({
    query: "",
    quick: QUICK,
    recent: [fileCandidate("src/auth/session.ts", "recent")],
    workspace: [fileCandidate("src/auth/router.ts")],
  });

  assert.deepEqual(result.groups.map((group) => group.id), ["quick", "recent", "workspace"]);
  assert.deepEqual(result.groups[0]?.candidates.map((item) => item.label), [
    "当前文件", "选中代码", "问题面板 (3)",
  ]);
  assert.equal(result.truncated, false);
});

test("逐字过滤：文件名前缀优先于路径子串", () => {
  const result = buildSuggestions({
    query: "router",
    quick: QUICK,
    recent: [],
    workspace: [
      fileCandidate("src/router-helpers/util.ts"),
      fileCandidate("src/auth/router.ts"),
    ],
  });

  const workspace = result.groups.find((group) => group.id === "workspace");
  assert.deepEqual(workspace?.candidates.map((item) => item.detail), [
    "src/auth/router.ts",
    "src/router-helpers/util.ts",
  ]);
  // 快捷上下文与 router 无关，过滤后整组消失，不留空标题。
  assert.equal(result.groups.some((group) => group.id === "quick"), false);
});

test("快捷上下文可按标签命中", () => {
  const result = buildSuggestions({ query: "问题", quick: QUICK, recent: [], workspace: [] });
  assert.deepEqual(result.groups[0]?.candidates.map((item) => item.label), ["问题面板 (3)"]);
});

test("工作区候选最多 20 项并给出截断提示文案", () => {
  const files = Array.from({ length: 30 }, (_, index) => fileCandidate(`src/mod${index}/router.ts`));
  const result = buildSuggestions({ query: "router", quick: [], recent: [], workspace: files });

  const workspace = result.groups.find((group) => group.id === "workspace");
  assert.equal(workspace?.candidates.length, WORKSPACE_LIMIT);
  assert.equal(result.truncated, true);
  assert.equal(result.matched, 30);
  assert.equal(truncationHint(WORKSPACE_LIMIT), "仅显示前 20 项，请继续输入以缩小范围。");
});

test("最近使用最多 5 项，且不与工作区组重复", () => {
  const recent = Array.from({ length: 8 }, (_, index) => fileCandidate(`src/recent${index}.ts`, "recent"));
  const result = buildSuggestions({
    query: "",
    quick: [],
    recent,
    workspace: [...recent.map((item) => fileCandidate(item.detail as string)), fileCandidate("src/other.ts")],
  });

  const recentGroup = result.groups.find((group) => group.id === "recent");
  const workspaceGroup = result.groups.find((group) => group.id === "workspace");
  assert.equal(recentGroup?.candidates.length, RECENT_LIMIT);
  const recentPaths = new Set(recentGroup?.candidates.map((item) => item.detail));
  assert.equal(
    workspaceGroup?.candidates.some((item) => recentPaths.has(item.detail)),
    false,
    "同一文件不应同时出现在两组里",
  );
});

test("候选 detail 只承载相对路径，不出现绝对路径形态", () => {
  const result = buildSuggestions({
    query: "",
    quick: QUICK,
    recent: [],
    workspace: [fileCandidate("src/auth/router.ts")],
  });
  for (const group of result.groups) {
    for (const candidate of group.candidates) {
      const detail = candidate.detail ?? "";
      assert.equal(/^[A-Za-z]:/.test(detail), false, `不应出现盘符：${detail}`);
      assert.equal(detail.startsWith("/"), false, `不应以斜杠开头：${detail}`);
    }
  }
});

test("禁用候选不参与键盘选择", () => {
  const result = buildSuggestions({ query: "", quick: QUICK, recent: [], workspace: [] });
  const selectable = selectableCandidates(result.groups);
  assert.deepEqual(selectable.map((item) => item.id), ["q-current-file", "q-problems"]);
});

test("不匹配的候选返回 undefined 分数", () => {
  assert.equal(scoreCandidate("zzz", fileCandidate("src/auth/router.ts")), undefined);
  assert.equal(scoreCandidate("router", fileCandidate("src/auth/router.ts")), 0);
  assert.equal(scoreCandidate("auth", fileCandidate("src/auth/router.ts")), 2);
});

test("@ 触发只在词首生效，邮箱与行内 @ 不误触", () => {
  assert.deepEqual(readMentionQuery("@rou", 4), { start: 0, query: "rou" });
  assert.deepEqual(readMentionQuery("看下 @router.ts", 13), { start: 3, query: "router.ts" });
  assert.equal(readMentionQuery("mail a@b.com", 12), undefined);
  assert.equal(readMentionQuery("@rou 之后的正文", 8), undefined);
  assert.equal(readMentionQuery("没有触发词", 5), undefined);
});
