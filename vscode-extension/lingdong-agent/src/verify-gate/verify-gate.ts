/**
 * 校验闭环钩子进程。由 Grok 在 UserPromptSubmit / PostToolUse / Stop 三个事件上拉起。
 *
 * 这是一个独立打包的入口（dist/verify-gate.js），不是扩展的一部分：
 * 它在 Grok 的子进程里跑，拿不到 vscode API，只能靠 stdin 的事件 JSON 与环境变量。
 *
 * 三个事件各司其职：
 * - UserPromptSubmit：新一轮开始，清掉上一轮的脏标记与拦截计数。
 * - PostToolUse（编辑类工具）：标记本轮动过文件。
 * - Stop：真正的门。改过文件就跑一次项目自己的校验命令，失败则回灌错误阻止收尾。
 *
 * 一切失败都放行（fail-open）。钩子挂掉不该让用户的任务卡死——文档也是这个约定。
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  chooseVerifyCommand,
  composeBlockReason,
  decideStopGate,
  isToolingFailure,
  type VerifyCommand,
} from "./verify-plan";

interface HookEvent {
  hookEventName?: string;
  sessionId?: string;
  cwd?: string;
  workspaceRoot?: string;
  reason?: string;
  stopHookActive?: boolean;
  toolName?: string;
  backgroundTasks?: unknown[];
}

interface TurnState {
  dirty: boolean;
  blockCount: number;
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parseEvent(raw: string): HookEvent {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as HookEvent) : {};
  } catch {
    return {};
  }
}

/** 状态放系统临时目录，绝不写进用户仓库——那会污染 git status。 */
function stateFile(sessionId: string): string {
  const directory = path.join(tmpdir(), "lingdong-verify-gate");
  mkdirSync(directory, { recursive: true });
  // sessionId 是 UUID，但仍然过一遍白名单，避免被拼出路径穿越。
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
  return path.join(directory, `${safe}.json`);
}

function readState(file: string): TurnState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return { dirty: false, blockCount: 0 };
    const record = parsed as Partial<TurnState>;
    return {
      dirty: record.dirty === true,
      blockCount: typeof record.blockCount === "number" ? record.blockCount : 0,
    };
  } catch {
    return { dirty: false, blockCount: 0 };
  }
}

function writeState(file: string, state: TurnState): void {
  try {
    writeFileSync(file, `${JSON.stringify(state)}\n`, "utf8");
  } catch {
    // 状态写不进去只会退化成「不校验」，不该让整轮失败。
  }
}

function resolveCommand(root: string): VerifyCommand | undefined {
  let packageJsonText: string | undefined;
  try {
    packageJsonText = readFileSync(path.join(root, "package.json"), "utf8");
  } catch {
    packageJsonText = undefined;
  }
  const hasTsconfig = existsSync(path.join(root, "tsconfig.json"));
  return chooseVerifyCommand(packageJsonText, hasTsconfig);
}

interface VerifyFailure {
  /** 回灌给模型的文本，取可读性最好的那个解码结果。 */
  text: string;
  /** 所有解码变体，交给 isToolingFailure 逐个匹配。 */
  variants: string[];
}

/**
 * 按字节解码，必要时再按 GBK 解一遍。
 *
 * tsc / eslint 一律输出 UTF-8，所以出现 U+FFFD 基本只有一种来源：
 * 中文 Windows 的 shell 用 OEM 代码页报「不是内部或外部命令」。
 */
function decodeOutput(buffer: Buffer): VerifyFailure {
  const utf8 = buffer.toString("utf8");
  if (!utf8.includes("\uFFFD")) return { text: utf8, variants: [utf8] };
  let oem = "";
  try {
    oem = new TextDecoder("gbk").decode(buffer);
  } catch {
    // 精简版 ICU 不带 gbk，那就只能拿 UTF-8 那份凑合。
  }
  return oem ? { text: oem, variants: [utf8, oem] } : { text: utf8, variants: [utf8] };
}

/** 跑校验。返回 undefined 表示通过。 */
function runVerify(command: VerifyCommand, root: string): VerifyFailure | undefined {
  try {
    execSync(command.commandLine, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10 * 60 * 1000,
      windowsHide: true,
    });
    return undefined;
  } catch (error) {
    const shaped = error as { stdout?: Buffer; stderr?: Buffer; message?: string; signal?: string };
    // 超时被杀时 stdout/stderr 往往是空的，那不是「校验失败」，按放行处理。
    if (shaped.signal) return undefined;
    const decoded = decodeOutput(
      Buffer.concat([
        Buffer.isBuffer(shaped.stdout) ? shaped.stdout : Buffer.alloc(0),
        Buffer.from("\n"),
        Buffer.isBuffer(shaped.stderr) ? shaped.stderr : Buffer.alloc(0),
      ]),
    );
    const text = decoded.text.trim();
    if (text) return { text, variants: decoded.variants };
    const fallback = shaped.message ?? "校验命令以非零状态退出，但没有任何输出。";
    return { text: fallback, variants: [fallback] };
  }
}

function main(): void {
  const event = parseEvent(readStdin());
  const eventName = (event.hookEventName ?? process.env.GROK_HOOK_EVENT ?? "").toLowerCase();
  const sessionId = event.sessionId ?? process.env.GROK_SESSION_ID ?? "";
  const root = event.workspaceRoot ?? process.env.GROK_WORKSPACE_ROOT ?? event.cwd ?? process.cwd();
  const file = stateFile(sessionId);

  if (eventName === "user_prompt_submit") {
    // 新一轮：直接删掉状态文件，比写一份全 false 更干净。
    try {
      rmSync(file, { force: true });
    } catch {
      // 删不掉就留着，下一次 Stop 最多多跑一次校验。
    }
    return;
  }

  if (eventName === "post_tool_use") {
    const state = readState(file);
    writeState(file, { ...state, dirty: true });
    return;
  }

  if (eventName !== "stop") return;

  const state = readState(file);
  const command = resolveCommand(root);
  const action = decideStopGate({
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
    ...(event.stopHookActive !== undefined ? { stopHookActive: event.stopHookActive } : {}),
    dirty: state.dirty,
    blockCount: state.blockCount,
    hasCommand: command !== undefined,
    backgroundTaskCount: Array.isArray(event.backgroundTasks) ? event.backgroundTasks.length : 0,
  });

  if (action.kind === "allow" || !command) return;

  const failure = runVerify(command, root);
  if (failure && isToolingFailure(...failure.variants)) {
    // 工具没装不是代码的问题。拦住它只会让模型对着一句「命令不存在」乱改，
    // 而且每一轮都拦一次。清掉脏标记直接放行。
    writeState(file, { dirty: false, blockCount: state.blockCount });
    return;
  }
  if (!failure) {
    // 过了就清掉脏标记：同一轮后续的 Stop 不必再跑一遍几十秒的检查。
    writeState(file, { dirty: false, blockCount: state.blockCount });
    return;
  }

  writeState(file, { dirty: true, blockCount: state.blockCount + 1 });
  process.stdout.write(`${JSON.stringify({
    decision: "block",
    reason: composeBlockReason(command, failure.text),
  })}\n`);
}

main();
