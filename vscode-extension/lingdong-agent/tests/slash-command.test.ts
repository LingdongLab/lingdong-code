import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_ONLY_COMMANDS,
  SLASH_COMMANDS,
  filterSlashCommands,
  findSlashCommand,
  readSlashQuery,
  type SlashState,
} from "../src/composer/slash-command";

const READY: SlashState = { canSwitchMode: true, canCancel: false, canSend: true };
const BUSY: SlashState = { canSwitchMode: false, canCancel: true, canSend: false };

test("首个非空字符为 / 时才识别命令", () => {
  assert.deepEqual(readSlashQuery("/plan", 5), { start: 0, query: "plan", end: 5 });
  assert.deepEqual(readSlashQuery("  /new", 6), { start: 2, query: "new", end: 6 });
  assert.equal(readSlashQuery("看下 /plan", 9), undefined, "斜杠不在开头不算命令");
  assert.equal(readSlashQuery("/tmp 下的脚本坏了", 12), undefined, "光标已离开命令词，按普通提问处理");
});

test("按前缀过滤命令", () => {
  const ids = filterSlashCommands("pla", READY).map((entry) => entry.command.id);
  assert.deepEqual(ids, ["plan"]);
});

test("允许列表之外的 id 一律拒绝", () => {
  assert.equal(findSlashCommand("plan")?.trigger, "/plan");
  assert.equal(findSlashCommand("rm-rf"), undefined);
  assert.equal(findSlashCommand("workbench.action.terminal.new"), undefined);
  assert.equal(findSlashCommand(""), undefined);
});

test("未接线的能力不出现在命令表里", () => {
  const triggers = new Set(SLASH_COMMANDS.flatMap(
    (command) => [command.id, ...(command.aliases ?? [])],
  ));
  for (const absent of ["image", "imagine", "branch", "checkpoint", "dream", "loop"]) {
    assert.equal(triggers.has(absent), false, `${absent} 尚未实现，不应出现在候选里`);
  }
});

test("命令 id 与别名之间没有重名", () => {
  const seen = new Map<string, string>();
  for (const command of SLASH_COMMANDS) {
    for (const word of [command.id, ...(command.aliases ?? [])]) {
      const owner = seen.get(word);
      assert.equal(owner, undefined, `/${word} 同时属于 ${owner} 与 ${command.id}`);
      seen.set(word, command.id);
    }
  }
});

test("本地命令与「Grok 终端专属」两张表不重叠", () => {
  for (const command of SLASH_COMMANDS) {
    for (const word of [command.id, ...(command.aliases ?? [])]) {
      assert.equal(
        Object.hasOwn(NATIVE_ONLY_COMMANDS, word),
        false,
        `/${word} 既在本地表里又被标成不可用`,
      );
    }
  }
});

test("任务执行中禁用模式切换并说明原因", () => {
  const plan = filterSlashCommands("plan", BUSY)[0];
  assert.equal(plan?.disabledReason, "当前任务执行中，暂时不能切换模式");
  const retry = filterSlashCommands("retry", BUSY)[0];
  assert.equal(retry?.disabledReason, "当前任务执行中，暂时不能重试");
  // 忙的时候「停止」反而可用。
  assert.equal(filterSlashCommands("stop", BUSY)[0]?.disabledReason, undefined);
});

test("空闲时停止命令被禁用", () => {
  assert.equal(filterSlashCommands("stop", READY)[0]?.disabledReason, "当前没有正在执行的任务");
});

test("每条命令都映射到已有宿主消息或纯客户端动作", () => {
  // 这张白名单就是「命令表不许发明新协议」这条约束的执行点：
  // 想加命令，先确认宿主已经有这个能力，再把消息类型写进来。
  const allowedHostTypes = new Set([
    "setMode", "newSession", "stop", "compactContext", "clearContext",
    "openNativeTerminal", "openSimpleBrowser",
    "requestUsageDetail", "openHistory", "openExtensions", "openModelSettings",
    "openSettings", "showLogs", "reconnect",
  ]);
  for (const command of SLASH_COMMANDS) {
    if (command.target.kind === "host") {
      assert.ok(
        allowedHostTypes.has(command.target.message.type),
        `${command.trigger} 使用了未预期的宿主消息 ${command.target.message.type}`,
      );
    } else {
      assert.ok(["retry", "openChanges", "openFiles", "help"].includes(command.target.action));
    }
  }
});
