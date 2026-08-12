import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPreviewUri,
  EditPreviewPlanner,
  EDIT_PREVIEW_SCHEME,
  parsePreviewUri,
  type EditPreviewMode,
} from "../src/preview/edit-preview-model";

function planner(options: {
  mode?: EditPreviewMode;
  allow?: (file: string) => boolean;
  maxBytes?: number;
} = {}) {
  const state = { mode: options.mode ?? ("diff" as EditPreviewMode) };
  const instance = new EditPreviewPlanner({
    mode: () => state.mode,
    allow: options.allow ?? (() => true),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
  return { instance, state };
}

const DIFF = {
  toolCallId: "call-1",
  file: "src/app.ts",
  change: "modify" as const,
  oldText: "const a = 1;\n",
  newText: "const a = 2;\n",
  pending: true,
};

test("URI 往返：文件路径与侧别原样取回", () => {
  const parts = buildPreviewUri("E:\\proj\\src\\app.ts", "before", 3);
  assert.equal(parts.scheme, EDIT_PREVIEW_SCHEME);
  const parsed = parsePreviewUri(parts.query);
  assert.deepEqual(parsed, { file: "E:\\proj\\src\\app.ts", side: "before", revision: 3 });
});

test("URI 的 path 带文件名，编辑器标题栏才认得出", () => {
  const parts = buildPreviewUri("src/app.ts", "after", 1);
  assert.ok(parts.path.endsWith("app.ts"));
});

test("坏 query 解析成 undefined 而不是抛错", () => {
  assert.equal(parsePreviewUri(""), undefined);
  assert.equal(parsePreviewUri("file=a.ts&side=middle"), undefined);
});

test("拿到前后全文即开 diff，pending 时右侧仍是虚拟文档", () => {
  const { instance } = planner();
  const action = instance.onDiff(DIFF);
  assert.equal(action.kind, "diff");
  if (action.kind !== "diff") return;
  assert.equal(action.file, "src/app.ts");
  assert.equal(action.rightIsFile, false, "还没落盘就指向真实文件会显示旧内容");
  assert.match(action.title, /修改中/);
  assert.equal(action.revision, 1);
});

test("工具收尾后右侧切到真实文件，用户可就地继续改", () => {
  const { instance } = planner();
  instance.onDiff(DIFF);
  const action = instance.onDiff({ ...DIFF, pending: false, newText: "const a = 3;\n" });
  assert.equal(action.kind, "diff");
  if (action.kind !== "diff") return;
  assert.equal(action.rightIsFile, true);
  assert.equal(action.revision, 2, "内容变了要换 revision，否则编辑器拿缓存");
  assert.match(action.title, /已修改/);
});

test("内容没变的重复 update 不再抢一次焦点", () => {
  const { instance } = planner();
  assert.equal(instance.onDiff(DIFF).kind, "diff");
  assert.equal(instance.onDiff(DIFF).kind, "none");
});

test("内容真的变了就重开，即使 pending 不变", () => {
  const { instance } = planner();
  instance.onDiff(DIFF);
  assert.equal(instance.onDiff({ ...DIFF, newText: "const a = 9;\n" }).kind, "diff");
});

test("content() 按侧别取回文本", () => {
  const { instance } = planner();
  instance.onDiff(DIFF);
  assert.equal(instance.content("src/app.ts", "before"), DIFF.oldText);
  assert.equal(instance.content("src/app.ts", "after"), DIFF.newText);
  assert.equal(instance.content("src/other.ts", "before"), undefined);
});

test("off 档什么都不做", () => {
  const { instance } = planner({ mode: "off" });
  assert.equal(instance.onDiff(DIFF).kind, "none");
  assert.equal(instance.onEditTarget("call-1", "edit", "src/app.ts").kind, "none");
});

test("reveal 档只揭示文件，不开 diff", () => {
  const { instance } = planner({ mode: "reveal" });
  const action = instance.onDiff(DIFF);
  assert.equal(action.kind, "reveal");
});

test("删除文件在 reveal 档没有可揭示的东西", () => {
  const { instance } = planner({ mode: "reveal" });
  assert.equal(instance.onDiff({ ...DIFF, change: "delete" }).kind, "none");
});

test("超过字节上限退回揭示，不让大文件 diff 卡住 UI", () => {
  const { instance } = planner({ maxBytes: 16 });
  const action = instance.onDiff({ ...DIFF, oldText: "x".repeat(40), newText: "y".repeat(40) });
  assert.equal(action.kind, "reveal");
});

test("仓库外的文件一律不预览", () => {
  const { instance } = planner({ allow: (file) => file.startsWith("src/") });
  assert.equal(instance.onDiff({ ...DIFF, file: "C:/Temp/scratch.ts" }).kind, "none");
  assert.equal(instance.onEditTarget("c", "edit", "C:/Temp/scratch.ts").kind, "none");
});

test("参数流阶段先揭示目标文件，同一次调用只揭示一次", () => {
  const { instance } = planner();
  const first = instance.onEditTarget("call-1", "edit", "src/app.ts");
  assert.equal(first.kind, "reveal");
  if (first.kind === "reveal") assert.equal(first.file, "src/app.ts");
  assert.equal(instance.onEditTarget("call-1", "edit", "src/app.ts").kind, "none");
});

test("只读类工具不触发预览", () => {
  const { instance } = planner();
  assert.equal(instance.onEditTarget("call-1", "read", "src/app.ts").kind, "none");
  assert.equal(instance.onEditTarget("call-2", "execute", "src/app.ts").kind, "none");
  assert.equal(instance.onEditTarget("call-3", "edit", "   ").kind, "none");
});

test("已经开过 diff 的文件不会被后续参数流顶回普通编辑器", () => {
  const { instance } = planner();
  instance.onDiff(DIFF);
  assert.equal(instance.onEditTarget("call-2", "edit", "src/app.ts").kind, "none");
});

test("reset 之后不再持有上一轮的文本", () => {
  const { instance } = planner();
  instance.onDiff(DIFF);
  assert.deepEqual(instance.previewedFiles, ["src/app.ts"]);
  instance.reset();
  assert.deepEqual(instance.previewedFiles, []);
  assert.equal(instance.content("src/app.ts", "before"), undefined);
  assert.equal(instance.onEditTarget("call-1", "edit", "src/app.ts").kind, "reveal");
});

test("新建文件的标题说「新建」", () => {
  const { instance } = planner();
  const action = instance.onDiff({ ...DIFF, change: "create", oldText: "", pending: false });
  assert.equal(action.kind, "diff");
  if (action.kind !== "diff") return;
  assert.match(action.title, /已新建：app\.ts/);
});
