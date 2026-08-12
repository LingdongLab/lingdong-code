import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createNodeFileSystem } from "../src/file-system-port";
import { ManagedGrokHome, SEED_MARKER } from "../src/privacy/managed-grok-home";

async function createSource(): Promise<string> {
  const source = await mkdtemp(path.join(tmpdir(), "lingdong-grok-src-"));
  await mkdir(path.join(source, "vendor", "ripgrep"), { recursive: true });
  await writeFile(path.join(source, "vendor", "ripgrep", "rg.exe"), "binary");
  await writeFile(path.join(source, "agent_id"), "agent-1234");
  await writeFile(path.join(source, ".metadata_version"), "1");
  // 下面这些都不该被复制。
  await writeFile(path.join(source, "config.toml"), "[models]\ndefault = \"old\"\n");
  await mkdir(path.join(source, "installer-profile"), { recursive: true });
  await writeFile(path.join(source, "installer-profile", "big.exe"), "140MB");
  await mkdir(path.join(source, "sessions"), { recursive: true });
  await writeFile(path.join(source, "sessions", "s1.json"), "{}");
  await mkdir(path.join(source, "logs"), { recursive: true });
  await writeFile(path.join(source, "logs", "app.log"), "line");
  return source;
}

async function createHome(): Promise<{ home: ManagedGrokHome; storageRoot: string }> {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "lingdong-store-"));
  return {
    home: new ManagedGrokHome({ fs: createNodeFileSystem(), storageRoot }),
    storageRoot,
  };
}

test("托管目录建在扩展存储下，播种只带必要文件", async () => {
  const source = await createSource();
  const { home, storageRoot } = await createHome();

  const directory = await home.ensure({ source, grokVersion: "0.2.118" });
  assert.equal(directory, path.join(storageRoot, "grok-home"));
  assert.ok(existsSync(path.join(directory, "vendor", "ripgrep", "rg.exe")), "vendor 应被复制");
  assert.equal(await readFile(path.join(directory, "agent_id"), "utf8"), "agent-1234");
  assert.ok(existsSync(path.join(directory, ".metadata_version")));
});

test("排除清单生效：config.toml、安装包、日志与旧会话都不复制", async () => {
  const source = await createSource();
  const { home } = await createHome();
  const directory = await home.ensure({ source });

  // config.toml 由我们整份生成，复制过来会被立刻覆盖，还可能与 grok 并发写冲突。
  assert.equal(existsSync(path.join(directory, "config.toml")), false);
  assert.equal(existsSync(path.join(directory, "installer-profile")), false);
  assert.equal(existsSync(path.join(directory, "logs")), false);
  assert.equal(existsSync(path.join(directory, "sessions")), false);
});

test("只播种一次：第二次 ensure 不再覆盖用户后来放进去的东西", async () => {
  const source = await createSource();
  const { home } = await createHome();
  const directory = await home.ensure({ source });

  await writeFile(path.join(directory, "agent_id"), "changed-by-user");
  await home.ensure({ source });
  assert.equal(await readFile(path.join(directory, "agent_id"), "utf8"), "changed-by-user");
});

test("播种标记记下来源与版本，便于发现源目录搬走", async () => {
  const source = await createSource();
  const { home } = await createHome();
  const directory = await home.ensure({ source, grokVersion: "0.2.118" });

  assert.ok(existsSync(path.join(directory, SEED_MARKER)));
  const marker = await home.readMarker();
  assert.equal(marker?.seededFrom, source);
  assert.equal(marker?.grokVersion, "0.2.118");
  assert.equal(typeof marker?.seededAt, "number");
  assert.equal(await home.isSeeded(), true);
});

test("没有源目录也能建出可用的托管目录", async () => {
  const { home } = await createHome();
  const directory = await home.ensure({});
  assert.ok(existsSync(directory));
  assert.equal(await home.isSeeded(), true);
});

test("写入的 config.toml 落在托管目录里", async () => {
  const { home } = await createHome();
  await home.ensure({});
  await home.writeConfig("[models]\ndefault = \"m1\"\n");
  assert.equal(await readFile(home.configFile, "utf8"), "[models]\ndefault = \"m1\"\n");
  assert.equal(path.dirname(home.configFile), home.directory);
});
