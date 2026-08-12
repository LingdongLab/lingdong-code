import assert from "node:assert/strict";
import test from "node:test";
import {
  EDIT_TOOL_MATCHER,
  composeHookCommandLine,
  renderVerifyHooks,
} from "../src/verify-gate/hooks-json";
import {
  MAX_BLOCKS_PER_TURN,
  chooseVerifyCommand,
  composeBlockReason,
  decideStopGate,
  FEEDBACK_MAX_LENGTH,
  isToolingFailure,
} from "../src/verify-gate/verify-plan";

test("优先用项目自己声明的 typecheck，而不是发明命令", () => {
  const chosen = chooseVerifyCommand(
    JSON.stringify({ scripts: { build: "tsc", typecheck: "tsc --noEmit", lint: "eslint ." } }),
    true,
  );
  assert.equal(chosen?.commandLine, "npm run typecheck");
});

test("没有 typecheck 时退到 lint，都没有才用 tsc --noEmit 兜底", () => {
  assert.equal(
    chooseVerifyCommand(JSON.stringify({ scripts: { lint: "eslint ." } }), false)?.commandLine,
    "npm run lint",
  );
  assert.equal(
    chooseVerifyCommand(JSON.stringify({ scripts: { build: "webpack" } }), true)?.label,
    "tsc --noEmit",
  );
});

test("既没有脚本也没有 tsconfig 就什么都不跑", () => {
  assert.equal(chooseVerifyCommand(undefined, false), undefined);
  assert.equal(chooseVerifyCommand(JSON.stringify({ scripts: { start: "node ." } }), false), undefined);
});

test("package.json 坏了不该让钩子崩，按「没有命令」处理", () => {
  assert.equal(chooseVerifyCommand("{ not json", false), undefined);
  assert.equal(chooseVerifyCommand("[]", false), undefined);
});

test("只有真正的轮次结束才校验：会话结束补发的 Stop 要放过", () => {
  const base = { dirty: true, blockCount: 0, hasCommand: true };
  assert.equal(decideStopGate({ ...base, reason: "end_turn" }).kind, "verify");
  assert.equal(decideStopGate({ ...base, reason: "channel_closed" }).kind, "allow");
  assert.equal(decideStopGate({ ...base, reason: "shutdown" }).kind, "allow");
});

test("没改过文件就不跑校验：白等几十秒是实打实的体验损失", () => {
  const action = decideStopGate({ dirty: false, blockCount: 0, hasCommand: true, reason: "end_turn" });
  assert.equal(action.kind, "allow");
  assert.match(action.kind === "allow" ? action.why : "", /没有改动文件/);
});

test("后台任务还在跑时这次 stop 不算收尾", () => {
  const action = decideStopGate({
    dirty: true,
    blockCount: 0,
    hasCommand: true,
    reason: "end_turn",
    backgroundTaskCount: 1,
  });
  assert.equal(action.kind, "allow");
  assert.match(action.kind === "allow" ? action.why : "", /后台任务/);
});

test("拦到上限必须放行，否则用户会被困在一轮里", () => {
  const base = { dirty: true, hasCommand: true, reason: "end_turn" };
  assert.equal(decideStopGate({ ...base, blockCount: MAX_BLOCKS_PER_TURN - 1 }).kind, "verify");
  const action = decideStopGate({ ...base, blockCount: MAX_BLOCKS_PER_TURN });
  assert.equal(action.kind, "allow");
  assert.match(action.kind === "allow" ? action.why : "", /交回给用户/);
});

test("项目没有校验命令时直接放行", () => {
  assert.equal(
    decideStopGate({ dirty: true, blockCount: 0, hasCommand: false, reason: "end_turn" }).kind,
    "allow",
  );
});

test("回灌文本说清这是自动校验而不是新需求", () => {
  const reason = composeBlockReason(
    { label: "npm run typecheck", commandLine: "npm run typecheck" },
    "src/a.ts(3,5): error TS2304: Cannot find name 'foo'.",
  );
  assert.match(reason, /自动校验未通过/);
  assert.match(reason, /不是新需求/);
  assert.match(reason, /TS2304/);
});

test("超长错误输出保尾部：错误计数与失败清单都在末尾", () => {
  const tail = "TOTAL 42 errors";
  const reason = composeBlockReason(
    { label: "tsc", commandLine: "tsc" },
    `${"x".repeat(FEEDBACK_MAX_LENGTH * 2)}\n${tail}`,
  );
  assert.ok(reason.includes(tail));
  assert.match(reason, /已省略前面/);
});

test("hooks JSON 覆盖三个事件，Stop 给足超时", () => {
  const json = JSON.parse(renderVerifyHooks({ commandLine: "node gate.js" }));
  assert.deepEqual(Object.keys(json.hooks).sort(), ["PostToolUse", "Stop", "UserPromptSubmit"]);
  assert.equal(json.hooks.PostToolUse[0].matcher, EDIT_TOOL_MATCHER);
  assert.equal(json.hooks.Stop[0].hooks[0].timeout, 900);
  // UserPromptSubmit 上的 matcher 会被 Grok 忽略并告警，所以压根不写。
  assert.equal("matcher" in json.hooks.UserPromptSubmit[0], false);
});

test("matcher 同时覆盖 Grok 原名与 Claude 别名", () => {
  for (const name of ["search_replace", "Edit", "Write", "MultiEdit", "apply_patch"]) {
    assert.ok(new RegExp(EDIT_TOOL_MATCHER).test(name), `matcher 漏了 ${name}`);
  }
});

test("需要额外环境变量时写进每个 handler（Code.exe 当 Node 的场景）", () => {
  const json = JSON.parse(renderVerifyHooks({
    commandLine: "Code.exe gate.js",
    env: { ELECTRON_RUN_AS_NODE: "1" },
  }));
  assert.equal(json.hooks.Stop[0].hooks[0].env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(json.hooks.PostToolUse[0].hooks[0].env.ELECTRON_RUN_AS_NODE, "1");
});

test("带空格的路径要加引号，否则 Windows 上必然拉不起来", () => {
  assert.equal(
    composeHookCommandLine("C:\\Program Files\\nodejs\\node.exe", "C:\\ext\\dist\\verify-gate.js"),
    '"C:\\Program Files\\nodejs\\node.exe" C:\\ext\\dist\\verify-gate.js',
  );
});

test("真实的编译错误不能被当成工具没装", () => {
  assert.equal(
    isToolingFailure("src/a.ts(1,26): error TS2322: Type 'string' is not assignable to type 'number'."),
    false,
  );
});

test("各平台的「命令不存在」都要认出来", () => {
  assert.ok(isToolingFailure("bash: eslint: command not found"));
  assert.ok(isToolingFailure("'tsc' is not recognized as an internal or external command"));
  assert.ok(isToolingFailure("Error: spawn tsc ENOENT"));
});

// 这条来自实测：中文 Windows 的 shell 用 OEM 代码页（GBK）报这句话，
// 按 UTF-8 解出来是乱码，一个正则都匹配不上，于是「工具没装」被当成代码有错，
// 每一轮都用一个假错误拦住 Agent。所以必须把 GBK 解码结果也一起送进来匹配。
test("中文 Windows 的 GBK 报错要靠第二个解码变体救回来", () => {
  const gbk = Buffer.from(
    "27666f6f2720b2bbcac7c4dab2bfbbf2cde2b2bfc3fcc1eea3acd2b2b2bbcac7bfc9d4cbd0d0b5c4b3ccd0f2",
    "hex",
  );
  const asUtf8 = gbk.toString("utf8");
  const asGbk = new TextDecoder("gbk").decode(gbk);

  assert.equal(isToolingFailure(asUtf8), false, "乱码本身匹配不上，这正是当初漏判的原因");
  assert.ok(isToolingFailure(asUtf8, asGbk), "带上 GBK 变体后必须认出来");
});
