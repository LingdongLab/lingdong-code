import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWindowShape,
  DEFAULT_SHAPE,
  otherShape,
  readShape,
  SHAPE_SETTING_KEY,
  shapeActions,
  type ShapeHost,
} from "../src/services/window-shape";

function recorder(failOn?: string): {
  host: ShapeHost;
  done: Array<{ kind: string; key: string; value?: string | boolean | undefined }>;
  logs: string[];
} {
  const done: Array<{ kind: string; key: string; value?: string | boolean | undefined }> = [];
  const logs: string[] = [];
  return {
    done,
    logs,
    host: {
      executeCommand: (command) => {
        if (command === failOn) return Promise.reject(new Error("命令不存在"));
        done.push({ kind: "command", key: command });
        return Promise.resolve(undefined);
      },
      updateGlobalSetting: (key, value) => {
        if (key === failOn) return Promise.reject(new Error("设置项不存在"));
        done.push({ kind: "setting", key, value });
        return Promise.resolve();
      },
      log: (line) => { logs.push(line); },
    },
  };
}

test("默认是 Agent 形态，取值不认识时也回落到它", () => {
  assert.equal(DEFAULT_SHAPE, "agent");
  assert.equal(readShape(undefined), "agent");
  assert.equal(readShape("ide"), "ide");
  assert.equal(readShape("agent"), "agent");
  assert.equal(readShape("classic"), "agent");
  assert.equal(readShape(42), "agent");
});

test("两个形态互为对方的另一面", () => {
  assert.equal(otherShape("agent"), "ide");
  assert.equal(otherShape("ide"), "agent");
});

test("Agent 形态先改设置再执行命令，主侧边栏只能靠命令关", () => {
  const actions = shapeActions("agent");
  const kinds = actions.map((action) => action.kind);
  assert.deepEqual(
    kinds,
    ["setting", "setting", "setting", "setting", "setting", "setting", "setting", "command"],
    "顺序反了会看到活动栏先闪一下",
  );
  assert.deepEqual(
    actions.filter((action) => action.kind === "command").map((action) => action.command),
    ["workbench.action.closeSidebar"],
  );
});

test("Agent 形态藏掉标题文字与编辑器动作", () => {
  const actions = shapeActions("agent");
  assert.deepEqual(
    actions.filter((action) => action.kind === "setting"),
    [
      { kind: "setting", key: "workbench.activityBar.location", value: "hidden" },
      { kind: "setting", key: "workbench.secondarySideBar.defaultVisibility", value: "hidden" },
      { kind: "setting", key: "workbench.editor.showTabs", value: "none" },
      { kind: "setting", key: "window.title", value: "" },
      { kind: "setting", key: "workbench.editor.editorActionsLocation", value: "hidden" },
      { kind: "setting", key: "window.commandCenter", value: false },
      { kind: "setting", key: "window.menuBarVisibility", value: "classic" },
    ],
  );
});

test("IDE 形态恢复标签与编辑器动作，Command Center 仍关", () => {
  const actions = shapeActions("ide");
  assert.deepEqual(actions, [
    { kind: "setting", key: "workbench.activityBar.location", value: "default" },
    { kind: "setting", key: "workbench.editor.showTabs", value: "multiple" },
    { kind: "setting", key: "workbench.editor.editorActionsLocation", value: "default" },
    { kind: "setting", key: "window.commandCenter", value: false },
    { kind: "setting", key: "window.menuBarVisibility", value: "classic" },
    { kind: "command", command: "workbench.action.focusSideBar" },
  ]);
});

test("摆布局按声明顺序逐步执行", async () => {
  const { host, done } = recorder();
  await applyWindowShape("agent", host);
  assert.deepEqual(done, [
    { kind: "setting", key: "workbench.activityBar.location", value: "hidden" },
    { kind: "setting", key: "workbench.secondarySideBar.defaultVisibility", value: "hidden" },
    { kind: "setting", key: "workbench.editor.showTabs", value: "none" },
    { kind: "setting", key: "window.title", value: "" },
    { kind: "setting", key: "workbench.editor.editorActionsLocation", value: "hidden" },
    { kind: "setting", key: "window.commandCenter", value: false },
    { kind: "setting", key: "window.menuBarVisibility", value: "classic" },
    { kind: "command", key: "workbench.action.closeSidebar" },
  ]);
});

test("单步失败只记日志，后续步骤照做", async () => {
  const { host, done, logs } = recorder("workbench.activityBar.location");
  await applyWindowShape("agent", host);
  assert.deepEqual(done.map((step) => step.key), [
    "workbench.secondarySideBar.defaultVisibility",
    "workbench.editor.showTabs",
    "window.title",
    "workbench.editor.editorActionsLocation",
    "window.commandCenter",
    "window.menuBarVisibility",
    "workbench.action.closeSidebar",
  ]);
  assert.ok(logs.some((line) => line.includes("workbench.activityBar.location")));
});

test("configurationDefaults 覆盖的默认值与 Agent 形态一致", () => {
  const manifest = require("../package.json") as {
    contributes: {
      configurationDefaults: Record<string, unknown>;
      configuration: { properties: Record<string, { default?: unknown; enum?: string[] }> };
      commands: Array<{ command: string }>;
    };
  };
  assert.equal(manifest.contributes.configurationDefaults["workbench.activityBar.location"], "hidden");
  assert.equal(manifest.contributes.configurationDefaults["workbench.editor.showTabs"], "none");
  assert.equal(manifest.contributes.configurationDefaults["workbench.editor.editorActionsLocation"], "hidden");
  assert.equal(manifest.contributes.configurationDefaults["window.title"], "");
  assert.equal(manifest.contributes.configurationDefaults["window.commandCenter"], false);
  assert.equal(manifest.contributes.configurationDefaults["window.menuBarVisibility"], "classic");

  const setting = manifest.contributes.configuration.properties[`lingdongAgent.${SHAPE_SETTING_KEY}`];
  assert.ok(setting, `设置项 lingdongAgent.${SHAPE_SETTING_KEY} 没在 package.json 里声明`);
  assert.equal(setting.default, DEFAULT_SHAPE);
  assert.deepEqual(setting.enum, ["agent", "ide"]);

  const commands = new Set(manifest.contributes.commands.map((entry) => entry.command));
  assert.ok(commands.has("lingdongAgent.toggleWindowShape"), "切形态的命令没注册，命令面板里找不到");
});
