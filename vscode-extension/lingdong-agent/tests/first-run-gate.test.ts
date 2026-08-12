import assert from "node:assert/strict";
import test from "node:test";
import { FIRST_RUN_CONTEXT_KEY, firstRunGate } from "../src/services/first-run-gate";

test("没有工作区时先引导加文件夹，哪怕 Key 也没填", () => {
  // 顺序不能反：没有工作区 Grok 根本不会启动，先让人去填 Key 是白跑一趟。
  assert.equal(firstRunGate({ hasWorkspace: false, hasApiKey: false }), "noWorkspace");
  assert.equal(firstRunGate({ hasWorkspace: false, hasApiKey: true }), "noWorkspace");
});

test("有工作区但没 Key 时引导去填 Key", () => {
  assert.equal(firstRunGate({ hasWorkspace: true, hasApiKey: false }), "noApiKey");
});

test("两样都齐了就不再挡路", () => {
  assert.equal(firstRunGate({ hasWorkspace: true, hasApiKey: true }), "ready");
});

test("context key 名字与 package.json 的 viewsWelcome 对得上", () => {
  // 这两处一旦对不上，引导会整段不显示，而且不报任何错。
  const manifest = require("../package.json") as {
    contributes: { viewsWelcome: Array<{ when?: string; contents: string }> };
  };
  const branches = manifest.contributes.viewsWelcome.filter((entry) => entry.when);
  assert.equal(branches.length, 3);
  for (const branch of branches) {
    assert.ok(
      branch.when?.startsWith(`${FIRST_RUN_CONTEXT_KEY} == `),
      `意料之外的 when 子句：${branch.when}`,
    );
  }

  const gates = branches.map((branch) => branch.when?.split(" == ")[1] ?? "");
  assert.deepEqual([...gates].sort(), ["noApiKey", "noWorkspace", "ready"]);
  // when 是表达式语法：取值里带连字符会被当成减号，三个分支会一起静默失配。
  for (const gate of gates) assert.match(gate, /^[A-Za-z]+$/);
});

test("引导里指向的命令都在 contributes.commands 里注册过", () => {
  const manifest = require("../package.json") as {
    contributes: {
      viewsWelcome: Array<{ contents: string }>;
      commands: Array<{ command: string }>;
    };
  };
  const registered = new Set(manifest.contributes.commands.map((entry) => entry.command));
  for (const entry of manifest.contributes.viewsWelcome) {
    for (const match of entry.contents.matchAll(/\(command:([\w.]+)\)/g)) {
      assert.ok(registered.has(match[1] ?? ""), `未注册的命令：${match[1]}`);
    }
  }
});
