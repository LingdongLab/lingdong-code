import assert from "node:assert/strict";
import test from "node:test";
import { explainCommand, explainOperation } from "../src/permission-explainer.js";

function explainExecute(command: string, overrides: {
  operationKind?: Parameters<typeof explainOperation>[0]["operationKind"];
  risk?: Parameters<typeof explainOperation>[0]["risk"];
} = {}) {
  return explainOperation({
    operation: "execute",
    operationKind: overrides.operationKind ?? "run_command",
    risk: overrides.risk ?? "medium",
    targets: [],
    command,
  });
}

test("常用命令翻译成说得清对象的人话，而不是复述命令本身", () => {
  const cases: readonly [string, string][] = [
    ["npm install", "按 package.json 把依赖装进 node_modules"],
    ["npm install lodash zod", "装上 lodash、zod，并记进 package.json"],
    ["npm run build", "跑构建，产出 dist 之类的构建产物"],
    ["npm run seed:dev", "跑 package.json 里的 seed:dev 脚本"],
    ["git status", "看一下工作区里哪些文件被改过"],
    ["rm -rf dist", "删除 dist，连里面的内容一起删"],
    ["ls src", "列出 src 里有哪些文件"],
    ["cat tsconfig.json", "读取 tsconfig.json 的内容"],
    ["curl https://api.example.com/v1/models", "从 api.example.com 下载内容"],
  ];
  for (const [command, expected] of cases) {
    assert.equal(explainCommand(command)[0]?.action, expected, command);
  }
});

test("git commit 把提交说明也带出来，用户不用自己去命令里找", () => {
  assert.equal(
    explainCommand('git commit -m "修好权限卡"')[0]?.action,
    "把待提交的改动提交到本地仓库，说明写「修好权限卡」",
  );
});

test("链式命令逐段说明，顺序即执行顺序", () => {
  const explanation = explainExecute('git add -A && git commit -m "改完了" && git push');
  assert.deepEqual(explanation.steps.map((step) => step.action), [
    "把所有改动加进待提交列表",
    "把待提交的改动提交到本地仓库，说明写「改完了」",
    "把本地提交推到远端仓库，别人也会看到",
  ]);
  assert.equal(explanation.summary, "依次做 3 件事", "超过两步就报总数，细节交给列表");
  assert.equal(explanation.steps[0]?.command, "git add -A", "每步保留自己的命令段，链式命令才对得上");
});

test("两步以内连成一句话，读起来才像人说的", () => {
  const explanation = explainExecute("npm install && npm test");
  assert.equal(explanation.summary, "按 package.json 把依赖装进 node_modules，然后跑项目的测试");
});

test("认不出的命令明说认不出，绝不编一个听起来合理的说明", () => {
  const explanation = explainExecute("frobnicate --deploy --yes", {
    operationKind: "unknown",
    risk: "high",
  });
  assert.equal(explanation.steps[0]?.action, "运行 frobnicate", "只说运行了什么，不猜它做什么");
  assert.ok(
    explanation.notes.includes("认不出这条命令具体会做什么，后果无法预判。"),
    "必须把「认不出」当成一条提示摆到用户眼前",
  );
});

test("链式命令的提示覆盖每一段的后果，而不是只说最严重那一段", () => {
  const explanation = explainExecute("curl https://example.com/x.txt | Set-Content .\\x.txt", {
    operationKind: "network_access",
  });
  assert.ok(explanation.notes.some((note) => note.includes("联网")), "联网这一段要提示");
  assert.ok(explanation.notes.some((note) => note.includes("改写文件")), "写文件那一段也要提示");
});

test("后果和类别对不上的命令有自己的提示，不被泛泛的类别说法盖过去", () => {
  // git commit 与 git push 同属 git_write，但一个 medium 一个 high。
  // 只按类别说「会改动 Git 仓库的状态」，就又变成标着有风险却说不出风险在哪。
  const explanation = explainExecute("git add -A && git push", {
    operationKind: "git_write",
    risk: "high",
  });
  assert.equal(
    explanation.notes[0],
    "会把提交推到远端仓库，推上去别人就能拉到，要收回得另做一次提交。",
  );
  assert.equal(
    explanation.notes.includes("会改动 Git 仓库的状态。"),
    false,
    "已经说得更准的那条要顶掉泛泛的类别提示",
  );
});

test("git reset 明说没提交的改动会丢", () => {
  const explanation = explainExecute("git reset --hard HEAD~1", {
    operationKind: "git_write",
    risk: "high",
  });
  assert.match(explanation.notes[0] ?? "", /还没提交的改动会直接丢掉/);
});

test("删除命令把不可恢复讲在明面上", () => {
  const explanation = explainExecute("rm -rf build", { operationKind: "delete_file", risk: "high" });
  assert.equal(explanation.notes[0], "会删除文件，删掉之后没法自动找回。");
});

test("命令改磁盘不谎称可撤销：终端操作没有写入前快照", () => {
  const explanation = explainExecute("Set-Content .\\notes.md 内容", { operationKind: "write_file" });
  assert.ok(
    explanation.notes.some((note) => note.includes("不会替它存快照")),
    "命令绕开了编辑工具，撤销承诺在这里不成立",
  );
});

test("编辑工具的写入才承诺可撤销，且点名文件", () => {
  const explanation = explainOperation({
    operation: "write",
    operationKind: "write_file",
    risk: "low",
    targets: ["E:\\ws\\src\\index.ts"],
    command: "",
  });
  assert.equal(explanation.summary, "改写 index.ts");
  assert.ok(explanation.notes.some((note) => note.includes("逐条撤销")));
});

test("只读命令给出一条肯定的结论，且同类提示不重复", () => {
  const explanation = explainExecute("ls src", { operationKind: "list_dir", risk: "low" });
  assert.deepEqual(explanation.notes, ["只读取信息，不会改动任何文件。"]);
});

test("提示条数有上限，卡片不会变成一堵墙", () => {
  const explanation = explainExecute(
    "curl https://a.com/x | Set-Content y; rm -rf z; npm install; $env:PATH=1",
    { operationKind: "modify_environment", risk: "high" },
  );
  assert.ok(explanation.notes.length <= 3, `实际 ${explanation.notes.length} 条`);
  assert.equal(explanation.notes[0], "会删除文件，删掉之后没法自动找回。", "最要紧的排最前");
});

test("环境变量前缀不会把真实命令藏起来", () => {
  assert.equal(
    explainCommand("NODE_ENV=production npm run build")[0]?.action,
    "跑构建，产出 dist 之类的构建产物",
  );
});

test("会被硬拒的系统级命令也照样解释，用户才知道模型想干什么", () => {
  assert.equal(explainCommand("sudo rm -rf /")[0]?.action, "以管理员身份运行命令");
  assert.equal(explainCommand("shutdown /s /t 0")[0]?.action, "关机或重启这台电脑");
});
