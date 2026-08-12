// 端到端驱动校验闭环钩子：按 Grok 的事件顺序喂给 dist/verify-gate.js，覆盖三种情形。
//
// 存在的理由：单测覆盖的是判断逻辑，覆盖不到「真的读 stdin、真的起子进程跑校验、
// 真的把 block JSON 打到 stdout」这条路。钩子跑在 Grok 的子进程里，一旦这条路断了，
// 表现是「什么都没发生」——最难查的那种。
//
// 三种情形分别对应三个真实风险：
//   A 真错误   → 必须拦住，否则功能等于没做
//   B 已修好   → 必须放行，否则用户被困在一轮里
//   C 工具没装 → 必须放行，否则每轮都用假错误骚扰模型
//
// 用法：node scripts/check-verify-gate.mjs
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const gate = path.resolve("dist/verify-gate.js");

/** 造一个项目，typecheck 脚本的行为由调用方决定。 */
async function makeProject(typecheckScript, checkerSource) {
  const project = await mkdtemp(path.join(tmpdir(), "lingdong-gate-"));
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({ name: "gate-probe", private: true, scripts: { typecheck: typecheckScript } }, null, 2),
    "utf8",
  );
  if (checkerSource) await writeFile(path.join(project, "checker.js"), checkerSource, "utf8");
  return project;
}

function fire(project, sessionId, event, extra = {}) {
  const payload = JSON.stringify({
    hookEventName: event,
    sessionId,
    cwd: project,
    workspaceRoot: project,
    ...extra,
  });
  try {
    return execFileSync(process.execPath, [gate], {
      input: payload,
      encoding: "utf8",
      cwd: project,
      env: { ...process.env, GROK_HOOK_EVENT: event, GROK_SESSION_ID: sessionId, GROK_WORKSPACE_ROOT: project },
      timeout: 5 * 60 * 1000,
      windowsHide: true,
    });
  } catch (error) {
    return `钩子进程失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

/** 走一遍「新一轮 → 改了文件 → 结束」并返回 Stop 的输出。 */
function runTurn(project, sessionId, stopExtra = {}) {
  fire(project, sessionId, "user_prompt_submit");
  fire(project, sessionId, "post_tool_use", { toolName: "search_replace" });
  return fire(project, sessionId, "stop", { reason: "end_turn", ...stopExtra });
}

function describe(output) {
  const trimmed = output.trim();
  if (!trimmed) return { blocked: false, note: "无输出（放行）" };
  try {
    const parsed = JSON.parse(trimmed);
    return {
      blocked: parsed.decision === "block",
      note: String(parsed.reason ?? "").split("\n").slice(-3).join(" / ").slice(0, 200),
    };
  } catch {
    return { blocked: false, note: `非 JSON 输出：${trimmed.slice(0, 200)}` };
  }
}

const report = {};

// A：真正的校验失败——checker 打印类型错误并以 1 退出。
const failing = await makeProject(
  "node checker.js",
  "console.log(\"src/a.ts(1,26): error TS2322: Type 'string' is not assignable to type 'number'.\");\nconsole.log('Found 1 error.');\nprocess.exit(1);\n",
);
report.A_真错误必须拦住 = describe(runTurn(failing, "probe-fail"));

// B：修好了——同一个项目，checker 改成成功退出。
await writeFile(path.join(failing, "checker.js"), "console.log('No errors.');\n", "utf8");
report.B_修好后必须放行 = describe(runTurn(failing, "probe-fixed"));

// C：工具没装——命令根本不存在。
const missing = await makeProject("lingdong-definitely-not-a-real-command --noEmit");
report.C_工具没装必须放行 = describe(runTurn(missing, "probe-missing"));

// D：没改文件就结束——不该跑校验。
const untouched = await makeProject("node checker.js", "process.exit(1);\n");
fire(untouched, "probe-clean", "user_prompt_submit");
report.D_没改文件不校验 = describe(fire(untouched, "probe-clean", "stop", { reason: "end_turn" }));

// E：会话结束补发的 Stop——即便脏也放过。
report.E_会话结束补发放行 = describe(runTurn(failing, "probe-endsession", { reason: "channel_closed" }));

const expectations = {
  A_真错误必须拦住: true,
  B_修好后必须放行: false,
  C_工具没装必须放行: false,
  D_没改文件不校验: false,
  E_会话结束补发放行: false,
};
report.结论 = Object.entries(expectations).every(([key, blocked]) => report[key].blocked === blocked)
  ? "全部符合预期"
  : "有不符合预期的情形，见上";

console.log(JSON.stringify(report, null, 2));
process.exit(report.结论 === "全部符合预期" ? 0 : 1);
