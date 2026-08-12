import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FileSystemPort } from "../src/file-system-port";
import { parseSkillFrontmatter, sanitizeSkillFolderName } from "../src/skills/skill-frontmatter";
import { SkillsService } from "../src/services/skills-service";

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
      for (const dir of [...dirs]) {
        if (dir === root || dir.startsWith(`${root}/`)) dirs.delete(dir);
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
      return files.has(key) || dirs.has(key) || [...files.keys()].some((item) => item.startsWith(`${key}/`));
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
      for (const dir of dirs) {
        if (!dir.startsWith(`${root}/`)) continue;
        const rest = dir.slice(root.length + 1);
        const name = rest.split("/")[0];
        if (name) names.set(name, true);
      }
      return [...names.entries()].map(([name, isDirectory]) => ({ name, isDirectory }));
    },
  };
}

test("解析 SKILL.md frontmatter", () => {
  const fm = parseSkillFrontmatter(`---
name: demo-skill
description: "演示技能"
---
# body
`);
  assert.equal(fm.name, "demo-skill");
  assert.equal(fm.description, "演示技能");
  assert.equal(sanitizeSkillFolderName("Demo Skill!!"), "demo-skill");
});

test("同时扫描托管 skills 与本机 ~/.grok/skills", async () => {
  const fs = memoryFs();
  const storageRoot = "/storage";
  const grokHome = "/storage/grok-home";
  const nativeSkillMd = path.join(os.homedir(), ".grok", "skills", "from-home", "SKILL.md");
  await fs.ensureDirectory(path.dirname(nativeSkillMd));
  await fs.write(nativeSkillMd, Buffer.from("---\nname: from-home\ndescription: native\n---\n"));

  const service = new SkillsService({
    fs,
    storageRoot,
    workspaceRoot: () => undefined,
    grokHome: () => grokHome,
  });
  const listed = await service.list();
  assert.ok(listed.some((item) => item.name === "from-home"), `实际列表：${listed.map((i) => i.name).join(",")}`);
  const paths = await service.skillConfigPaths();
  assert.equal(paths.length, 1);
  assert.ok(paths[0]?.includes(".grok"));
});

test("从文件夹安装并列出；禁用写入 prefs", async () => {
  const fs = memoryFs();
  const storageRoot = "/storage";
  const grokHome = "/storage/grok-home";
  const source = "/tmp/src-skill";
  await fs.ensureDirectory(source);
  await fs.write(
    path.posix.join(source, "SKILL.md"),
    Buffer.from("---\nname: hello-skill\ndescription: hi\n---\n# Hello\n"),
  );

  const service = new SkillsService({
    fs,
    storageRoot,
    workspaceRoot: () => undefined,
    grokHome: () => grokHome,
  });

  const installed = await service.installFromFolder(source, "user");
  assert.equal(installed.name, "hello-skill");
  assert.equal(installed.scope, "user");
  assert.equal(installed.disabled, false);

  const listed = await service.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.name, "hello-skill");

  await service.setSkillEnabled("hello-skill", false);
  const after = await service.list();
  assert.equal(after[0]?.disabled, true);
  assert.deepEqual(await service.disabledNames(), ["hello-skill"]);
});
