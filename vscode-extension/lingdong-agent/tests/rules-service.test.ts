import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import path from "node:path";
import test from "node:test";
import type { FileSystemPort } from "../src/file-system-port";
import {
  AGENTS_FILE_NAMES,
  approxTokens,
  isRuleMarkdown,
  ruleScanTargets,
  sanitizeRuleFileName,
} from "../src/rules/rule-files";
import { RulesService } from "../src/services/rules-service";

function memoryFs(): FileSystemPort & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const normalize = (p: string) => p.replace(/\\/g, "/");

  return {
    files,
    async read(p) {
      return files.get(normalize(p));
    },
    async write(p, data) {
      const key = normalize(p);
      files.set(key, data);
      dirs.add(path.posix.dirname(key));
    },
    async remove(p) {
      files.delete(normalize(p));
    },
    async removeDirectory(prefix) {
      const root = normalize(prefix).replace(/\/$/, "");
      for (const key of [...files.keys()]) {
        if (key === root || key.startsWith(`${root}/`)) files.delete(key);
      }
    },
    async rename(from, to) {
      const data = files.get(normalize(from));
      if (!data) throw new Error(`ENOENT ${from}`);
      files.delete(normalize(from));
      files.set(normalize(to), data);
    },
    async stat(p) {
      const data = files.get(normalize(p));
      return data ? { size: data.byteLength, modifiedAt: 0 } : undefined;
    },
    async exists(p) {
      const key = normalize(p);
      return files.has(key) || dirs.has(key);
    },
    async ensureDirectory(p) {
      dirs.add(normalize(p));
    },
    async list(p) {
      return (await this.listEntries(p)).map((item) => item.name);
    },
    async listEntries(p) {
      const root = normalize(p).replace(/\/$/, "");
      const names = new Map<string, boolean>();
      for (const key of files.keys()) {
        if (!key.startsWith(`${root}/`)) continue;
        const rest = key.slice(root.length + 1);
        const name = rest.split("/")[0];
        if (!name) continue;
        names.set(name, rest.includes("/"));
      }
      return [...names.entries()].map(([name, isDirectory]) => ({ name, isDirectory }));
    },
  };
}

test("扫描位置覆盖文档列出的每一处，且托管目录与本机 ~/.grok 去重", () => {
  const targets = ruleScanTargets({
    workspaceRoot: "/repo",
    grokHome: "/home/u/.grok",
    homeDir: "/home/u",
  });
  const paths = targets.map((item) => item.path.replace(/\\/g, "/"));

  for (const name of AGENTS_FILE_NAMES) {
    assert.ok(paths.includes(`/repo/${name}`), `缺少顶层文件 ${name}`);
  }
  assert.ok(paths.includes("/repo/.grok/rules"));
  assert.ok(paths.includes("/repo/.cursor/rules"));
  assert.ok(paths.includes("/repo/.claude/rules"));
  assert.ok(paths.includes("/home/u/.cursor/rules"));
  assert.ok(paths.includes("/home/u/.claude/rules"));
  // 托管 GROK_HOME 恰好就是 ~/.grok 时只出现一次。
  assert.equal(paths.filter((item) => item === "/home/u/.grok/rules").length, 1);
});

test("没有仓库时只剩用户级位置", () => {
  const targets = ruleScanTargets({ grokHome: "/storage/grok-home", homeDir: "/home/u" });
  assert.ok(targets.every((item) => item.scope === "user"));
});

test("只认 *.md；文件名清洗与 token 估算", () => {
  assert.equal(isRuleMarkdown("style.md"), true);
  assert.equal(isRuleMarkdown("style.MD"), true);
  // Cursor 的 .mdc 不被 Grok 当规则加载，列出来只会误导。
  assert.equal(isRuleMarkdown("style.mdc"), false);
  assert.equal(sanitizeRuleFileName("提交 规范"), "提交-规范.md");
  assert.equal(sanitizeRuleFileName("a/b:c.md"), "a-b-c.md");
  assert.equal(sanitizeRuleFileName("   "), "rule.md");
  assert.equal(approxTokens(400), 100);
});

test("列出项目与用户规则：带来源、作用域与近似 token", async () => {
  const fs = memoryFs();
  await fs.write("/repo/AGENTS.md", Buffer.from("x".repeat(40), "utf8"));
  await fs.write("/repo/.grok/rules/style.md", Buffer.from("y".repeat(8), "utf8"));
  await fs.write("/repo/.cursor/rules/legacy.md", Buffer.from("z".repeat(4), "utf8"));
  await fs.write("/repo/.cursor/rules/ignored.mdc", Buffer.from("q", "utf8"));
  await fs.write("/storage/grok-home/rules/global.md", Buffer.from("g".repeat(12), "utf8"));

  const service = new RulesService({
    fs,
    workspaceRoot: () => "/repo",
    grokHome: () => "/storage/grok-home",
    homeDir: () => "/home/u",
  });
  const listed = await service.list();
  const byLabel = new Map(listed.map((item) => [item.label, item]));

  assert.deepEqual(
    [...byLabel.keys()],
    ["AGENTS.md", ".grok/rules/style.md", ".cursor/rules/legacy.md", "rules/global.md"],
  );
  assert.equal(byLabel.get("AGENTS.md")?.kind, "agents");
  assert.equal(byLabel.get("AGENTS.md")?.approxTokens, 10);
  assert.equal(byLabel.get(".cursor/rules/legacy.md")?.vendor, "cursor");
  assert.equal(byLabel.get("rules/global.md")?.scope, "user");
  assert.ok(!byLabel.has(".cursor/rules/ignored.mdc"));
});

test("新建 AGENTS.md 用模板，已存在时不覆盖", async () => {
  const fs = memoryFs();
  const service = new RulesService({
    fs,
    workspaceRoot: () => "/repo",
    grokHome: () => "/storage/grok-home",
    homeDir: () => "/home/u",
  });

  const file = await service.ensureProjectAgents();
  assert.equal(file.replace(/\\/g, "/"), "/repo/AGENTS.md");
  const first = Buffer.from(fs.files.get("/repo/AGENTS.md") ?? new Uint8Array()).toString("utf8");
  assert.match(first, /# 项目规则/);

  await fs.write("/repo/AGENTS.md", Buffer.from("我自己写的", "utf8"));
  await service.ensureProjectAgents();
  assert.equal(
    Buffer.from(fs.files.get("/repo/AGENTS.md") ?? new Uint8Array()).toString("utf8"),
    "我自己写的",
  );
});

test("新建规则：项目落 .grok/rules，用户落托管目录，重名报错", async () => {
  const fs = memoryFs();
  const service = new RulesService({
    fs,
    workspaceRoot: () => "/repo",
    grokHome: () => "/storage/grok-home",
    homeDir: () => "/home/u",
  });

  const project = await service.createRule("project", "提交规范");
  assert.equal(project.replace(/\\/g, "/"), "/repo/.grok/rules/提交规范.md");
  const user = await service.createRule("user", "中文回复");
  assert.equal(user.replace(/\\/g, "/"), "/storage/grok-home/rules/中文回复.md");

  await assert.rejects(() => service.createRule("project", "提交规范"), /已存在/);
});

test("没有活动仓库时项目级操作被明确拒绝", async () => {
  const fs = memoryFs();
  const service = new RulesService({
    fs,
    workspaceRoot: () => undefined,
    grokHome: () => "/storage/grok-home",
    homeDir: () => "/home/u",
  });
  await assert.rejects(() => service.ensureProjectAgents(), /没有活动仓库/);
  await assert.rejects(() => service.createRule("project", "x"), /没有活动仓库/);
});
