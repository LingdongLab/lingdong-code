import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import path from "node:path";
import test from "node:test";
import type { FileSystemPort } from "../src/file-system-port";
import { detectLspServer } from "../src/lsp/detect-lsp";
import {
  composeLspEntry,
  findPreset,
  LSP_PRESETS,
  renderLspJson,
} from "../src/lsp/lsp-presets";
import { LspService } from "../src/services/lsp-service";

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

const TS_PRESET = findPreset("typescript");
assert.ok(TS_PRESET, "预置里必须有 typescript");

test("每个预置的 extensions 都是「带点扩展名 → languageId」的 map", () => {
  for (const preset of LSP_PRESETS) {
    const keys = Object.keys(preset.extensions);
    assert.ok(keys.length > 0, `${preset.id} 没声明扩展名`);
    for (const key of keys) {
      // Grok 解析文件归属时查的是 `.ts` 这种带点形式；写成 `ts` 永远匹配不上。
      assert.ok(key.startsWith("."), `${preset.id} 的扩展名 ${key} 缺少前导点`);
      assert.equal(typeof preset.extensions[key], "string");
    }
  }
});

test("Windows 的 .cmd 垫片交给 cmd /c 代跑", () => {
  const batch = composeLspEntry(TS_PRESET, "C:/n/typescript-language-server.cmd");
  assert.equal(batch.command, "cmd");
  assert.deepEqual(batch.args, ["/c", "C:/n/typescript-language-server.cmd", "--stdio"]);

  const exe = composeLspEntry(TS_PRESET, "C:/n/typescript-language-server.exe");
  assert.equal(exe.command, "C:/n/typescript-language-server.exe");
  assert.deepEqual(exe.args, ["--stdio"]);
});

test("渲染出的 lsp.json 是扁平 map，无条目时返回 undefined", () => {
  assert.equal(renderLspJson({}), undefined);
  const text = renderLspJson({
    typescript: composeLspEntry(TS_PRESET, "/usr/bin/typescript-language-server"),
  });
  assert.ok(text);
  const parsed = JSON.parse(text) as Record<string, { command: string; extensions: Record<string, string> }>;
  // 没有外层 lspServers 包装键：Grok 的 load_file 直接反序列化成「服务器名 → 配置」。
  assert.deepEqual(Object.keys(parsed), ["typescript"]);
  assert.equal(parsed.typescript?.command, "/usr/bin/typescript-language-server");
  assert.equal(parsed.typescript?.extensions[".ts"], "typescript");
});

test("探测优先用仓库内 node_modules/.bin，并按 PATHEXT 补后缀", async () => {
  const fs = memoryFs();
  await fs.write("/repo/node_modules/.bin/typescript-language-server", Buffer.from("sh", "utf8"));
  await fs.write("/repo/node_modules/.bin/typescript-language-server.cmd", Buffer.from("bat", "utf8"));

  const found = await detectLspServer(TS_PRESET, {
    exists: (file) => fs.exists(file),
    pathEnv: "C:/tools",
    pathExt: ".EXE;.CMD",
    delimiter: ";",
    workspaceRoot: "/repo",
  });
  assert.equal(found.source, "workspace");
  // 带后缀的候选优先：无后缀的那份是 shell 脚本，Windows 上根本跑不起来。
  assert.equal(found.command?.replace(/\\/g, "/"), "/repo/node_modules/.bin/typescript-language-server.cmd");
});

test("仓库里没有就回落 PATH；都没有时如实报未找到", async () => {
  const fs = memoryFs();
  await fs.write("/opt/bin/typescript-language-server", Buffer.from("x", "utf8"));

  const onPath = await detectLspServer(TS_PRESET, {
    exists: (file) => fs.exists(file),
    pathEnv: "/nowhere:/opt/bin",
    delimiter: ":",
    workspaceRoot: "/repo",
  });
  assert.equal(onPath.source, "path");
  assert.equal(onPath.command?.replace(/\\/g, "/"), "/opt/bin/typescript-language-server");

  const missing = await detectLspServer(TS_PRESET, {
    exists: async () => false,
    pathEnv: "/opt/bin",
    delimiter: ":",
  });
  assert.equal(missing.command, undefined);
  assert.equal(missing.source, undefined, "没探测到就不该声称来自哪里");
});

test("服务只写探测到且未被停用的 server", async () => {
  const fs = memoryFs();
  await fs.write("/opt/bin/typescript-language-server", Buffer.from("x", "utf8"));
  await fs.write("/opt/bin/gopls", Buffer.from("x", "utf8"));

  const service = new LspService({
    fs,
    storageRoot: "/storage",
    workspaceRoot: () => undefined,
    env: () => ({ PATH: "/opt/bin" }),
    platform: () => "linux",
  });

  const listed = await service.list();
  assert.equal(listed.length, LSP_PRESETS.length);
  assert.equal(listed.find((item) => item.id === "typescript")?.found, true);
  assert.equal(listed.find((item) => item.id === "rust")?.found, false);
  assert.equal(await service.activeCount(), 2);

  const config = await service.renderConfig();
  assert.ok(config);
  assert.deepEqual(Object.keys(JSON.parse(config) as object), ["go", "typescript"]);

  await service.setEnabled("go", false);
  const afterDisable = await service.renderConfig();
  assert.ok(afterDisable);
  assert.deepEqual(Object.keys(JSON.parse(afterDisable) as object), ["typescript"]);
  assert.equal(listed.length > 0 && (await service.list()).find((i) => i.id === "go")?.enabled, false);
  assert.equal(await service.activeCount(), 1);
});

test("一个都没装时不写 lsp.json；未知 id 拒绝写偏好", async () => {
  const fs = memoryFs();
  const service = new LspService({
    fs,
    storageRoot: "/storage",
    workspaceRoot: () => undefined,
    env: () => ({ PATH: "/opt/bin" }),
    platform: () => "linux",
  });
  assert.equal(await service.renderConfig(), undefined);
  await assert.rejects(() => service.setEnabled("nope", false), /未知的 language server/);
});
