import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateGroup } from "../src/composer/context-candidate";
import type { HostToWebviewMessage } from "../src/messages";
import { parseWebviewMessage } from "../src/messages";
import {
  ContextSuggestionService,
  type ActiveFileInfo,
  type ContextSuggestionDeps,
  type ResolvedCandidate,
} from "../src/services/context-suggestion-service";

interface Harness {
  service: ContextSuggestionService;
  posted: HostToWebviewMessage[];
  added: ResolvedCandidate[];
  setActive(info: ActiveFileInfo | undefined): void;
  setAddedKeys(keys: string[]): void;
  groups(): CandidateGroup[];
  group(id: CandidateGroup["id"]): CandidateGroup | undefined;
  last(): Extract<HostToWebviewMessage, { type: "contextSuggestResults" }>;
}

function createHarness(options: {
  files?: string[];
  active?: ActiveFileInfo | undefined;
  diagnostics?: number;
  terminalLines?: number;
  changedFiles?: string[];
} = {}): Harness {
  const posted: HostToWebviewMessage[] = [];
  const added: ResolvedCandidate[] = [];
  let active = options.active;
  let addedKeys: string[] = [];

  const deps: ContextSuggestionDeps = {
    post: (message) => posted.push(message),
    workspaceRoot: () => "E:/work/demo",
    listFiles: async () => options.files ?? [],
    activeFile: () => active,
    diagnosticsCount: () => options.diagnostics ?? 0,
    terminalLines: () => options.terminalLines ?? 0,
    addedKeys: () => addedKeys,
    changedFiles: () => options.changedFiles ?? [],
    add: async (target) => { added.push(target); },
  };
  // 关掉 TTL 缓存的影响：每次 suggest 都用递增时间，测试之间互不干扰。
  let clock = 0;
  const service = new ContextSuggestionService(deps, () => { clock += 10_000; return clock; });

  const last = (): Extract<HostToWebviewMessage, { type: "contextSuggestResults" }> => {
    const message = [...posted].reverse().find((entry) => entry.type === "contextSuggestResults");
    assert.ok(message, "应下发 contextSuggestResults");
    return message as Extract<HostToWebviewMessage, { type: "contextSuggestResults" }>;
  };

  return {
    service,
    posted,
    added,
    setActive: (info) => { active = info; },
    setAddedKeys: (keys) => { addedKeys = keys; },
    groups: () => last().groups,
    group: (id) => last().groups.find((group) => group.id === id),
    last,
  };
}

test("快捷上下文不可用时保留候选并说明原因", async () => {
  const harness = createHarness({ active: undefined, diagnostics: 0, terminalLines: 0 });
  await harness.service.suggest("");

  const quick = harness.group("quick");
  const reasons = new Map(quick?.candidates.map((item) => [item.source, item.disabledReason]));
  assert.equal(reasons.get("current-file"), "当前没有打开的文件");
  assert.equal(reasons.get("selection"), "当前没有选中内容");
  assert.equal(reasons.get("problems"), "当前没有诊断信息");
  assert.equal(reasons.get("terminal"), "还没有可用的终端输出");
});

test("可用状态来自真实数据：问题面板带真实条数", async () => {
  const harness = createHarness({
    active: { relativePath: "src/app.ts", hasSelection: true },
    diagnostics: 3,
    terminalLines: 12,
  });
  await harness.service.suggest("");

  const quick = harness.group("quick");
  const bySource = new Map(quick?.candidates.map((item) => [item.source, item]));
  assert.equal(bySource.get("problems")?.label, "问题面板 (3)");
  assert.equal(bySource.get("problems")?.disabledReason, undefined);
  assert.equal(bySource.get("selection")?.detail, "src/app.ts");
  assert.equal(bySource.get("terminal")?.detail, "12 行");
});

test("敏感文件与二进制文件不进候选", async () => {
  const harness = createHarness({
    files: [".env", "src/keys/id_rsa", "media/icon.png", "dist/bundle.js", "src/auth/router.ts"],
  });
  await harness.service.suggest("");

  const paths = harness.groups().flatMap((group) => group.candidates.map((item) => item.detail));
  assert.equal(paths.includes(".env"), false, "凭据文件不应出现");
  assert.equal(paths.includes("media/icon.png"), false, "二进制文件不应出现");
  assert.equal(paths.includes("dist/bundle.js"), false, "构建产物不应出现");
  assert.ok(paths.includes("src/auth/router.ts"));
});

test("最近打开的文件排在最近使用组，并按最新优先", async () => {
  const harness = createHarness({ files: ["a.ts", "b.ts", "c.ts"] });
  harness.service.noteOpened("a.ts");
  harness.service.noteOpened("c.ts");
  await harness.service.suggest("");

  assert.deepEqual(harness.group("recent")?.candidates.map((item) => item.detail), ["c.ts", "a.ts"]);
});

test("已加入的上下文标记为已添加，避免重复加入", async () => {
  const harness = createHarness({ files: ["src/auth/router.ts"] });
  harness.setAddedKeys(["file:src/auth/router.ts"]);
  await harness.service.suggest("router");

  const candidate = harness.group("workspace")?.candidates
    .find((item) => item.detail === "src/auth/router.ts");
  assert.equal(candidate?.alreadyAdded, true);
});

test("选中文件候选后交给既有上下文入口解析", async () => {
  const harness = createHarness({ files: ["src/auth/router.ts"] });
  await harness.service.suggest("router");
  const candidate = harness.group("workspace")?.candidates
    .find((item) => item.detail === "src/auth/router.ts");
  assert.ok(candidate);

  const ok = await harness.service.select(candidate!.id, "file");
  assert.equal(ok, true);
  assert.deepEqual(harness.added, [{ source: "file", relativePath: "src/auth/router.ts" }]);
});

test("注册表里查不到的 candidateId 一律拒绝", async () => {
  const harness = createHarness({ files: ["src/auth/router.ts"] });
  await harness.service.suggest("router");

  const ok = await harness.service.select("c999", "file");
  assert.equal(ok, false);
  assert.equal(harness.added.length, 0);
  assert.ok(harness.posted.some(
    (message) => message.type === "notice" && /失效/.test(message.message),
  ));
});

test("声称的 sourceType 与注册表不一致时拒绝", async () => {
  const harness = createHarness({ files: ["src/auth/router.ts"] });
  await harness.service.suggest("router");
  const candidate = harness.group("workspace")?.candidates
    .find((item) => item.detail === "src/auth/router.ts");

  const ok = await harness.service.select(candidate!.id, "folder");
  assert.equal(ok, false);
  assert.equal(harness.added.length, 0);
  assert.ok(harness.posted.some(
    (message) => message.type === "notice" && /校验失败/.test(message.message),
  ));
});

test("切换会话后旧候选 id 失效", async () => {
  const harness = createHarness({ files: ["src/auth/router.ts"] });
  await harness.service.suggest("router");
  const candidate = harness.group("workspace")?.candidates
    .find((item) => item.detail === "src/auth/router.ts");

  harness.service.reset();
  assert.equal(await harness.service.select(candidate!.id, "file"), false);
  assert.equal(harness.added.length, 0);
});

test("协议里没有路径字段，伪造的绝对路径无处可传", () => {
  assert.equal(
    parseWebviewMessage({ type: "contextSuggestSelect", candidateId: "c1", sourceType: "file" })?.type,
    "contextSuggestSelect",
  );
  // candidateId 必须过 isSafeId，任何路径形态都不合法。
  assert.equal(
    parseWebviewMessage({ type: "contextSuggestSelect", candidateId: "E:/etc/passwd", sourceType: "file" }),
    undefined,
  );
  assert.equal(
    parseWebviewMessage({ type: "contextSuggestSelect", candidateId: "../../secret", sourceType: "file" }),
    undefined,
  );
  // sourceType 走白名单。
  assert.equal(
    parseWebviewMessage({ type: "contextSuggestSelect", candidateId: "c1", sourceType: "shell" }),
    undefined,
  );
  // 额外字段不会被透传。
  const parsed = parseWebviewMessage({
    type: "contextSuggestSelect",
    candidateId: "c1",
    sourceType: "file",
    relativePath: "../../../etc/passwd",
  });
  assert.deepEqual(parsed, { type: "contextSuggestSelect", candidateId: "c1", sourceType: "file" });
});

test("查询串超长时被截断后再交给宿主", () => {
  const parsed = parseWebviewMessage({ type: "contextSuggestQuery", query: "x".repeat(500) });
  assert.equal(parsed?.type, "contextSuggestQuery");
  assert.equal((parsed as { query: string }).query.length, 200);
});
