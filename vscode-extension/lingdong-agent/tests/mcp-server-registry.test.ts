import assert from "node:assert/strict";
import test from "node:test";
import type { FileSystemPort } from "../src/file-system-port";
import { McpSecretStore } from "../src/mcp/mcp-secret-store";
import { McpServerRegistry } from "../src/mcp/mcp-server-registry";
import type { SecretStoragePort } from "../src/models/providers/provider-secret-store";

function memoryFs(): FileSystemPort {
  const files = new Map<string, Uint8Array>();
  const normalize = (p: string) => p.replace(/\\/g, "/");
  return {
    async read(p) { return files.get(normalize(p)); },
    async write(p, data) { files.set(normalize(p), data); },
    async remove(p) { files.delete(normalize(p)); },
    async removeDirectory(prefix) {
      const root = normalize(prefix);
      for (const key of [...files.keys()]) {
        if (key === root || key.startsWith(`${root}/`)) files.delete(key);
      }
    },
    async rename(from, to) {
      const data = files.get(normalize(from));
      if (!data) throw new Error("ENOENT");
      files.delete(normalize(from));
      files.set(normalize(to), data);
    },
    async stat(p) {
      const data = files.get(normalize(p));
      return data ? { size: data.byteLength, modifiedAt: 0 } : undefined;
    },
    async exists(p) { return files.has(normalize(p)); },
    async ensureDirectory() {},
    async list() { return []; },
    async listEntries() { return []; },
  };
}

function memorySecrets(): SecretStoragePort & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (key) => map.get(key),
    store: async (key, value) => { map.set(key, value); },
    delete: async (key) => { map.delete(key); },
  };
}

test("保留名 lingdong_web 不可创建；密钥不落盘", async () => {
  const secrets = memorySecrets();
  const registry = new McpServerRegistry({
    fs: memoryFs(),
    storageRoot: "/storage",
    secrets: new McpSecretStore(secrets),
  });

  await assert.rejects(
    () => registry.upsert({
      name: "lingdong_web",
      transport: "stdio",
      enabled: true,
      command: "node",
    }),
    /保留名/,
  );

  const saved = await registry.upsert({
    name: "demo_mcp",
    transport: "stdio",
    enabled: true,
    command: "npx",
    args: ["-y", "x"],
    secretEnv: { API_KEY: "super-secret-token-123" },
  });
  assert.equal(saved.name, "demo_mcp");
  assert.deepEqual(saved.secretEnvKeys, ["API_KEY"]);

  const file = await registry.list();
  const raw = JSON.stringify(file);
  assert.equal(raw.includes("super-secret-token-123"), false);

  const resolved = await registry.resolveEnabled();
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.env.API_KEY, "${LINGDONG_MCP_DEMO_MCP_API_KEY}");
  assert.equal(resolved[0]?.credentials[0]?.value, "super-secret-token-123");
  assert.ok([...secrets.map.values()].includes("super-secret-token-123"));
});

test("禁用服务器不出现在 resolveEnabled", async () => {
  const registry = new McpServerRegistry({
    fs: memoryFs(),
    storageRoot: "/storage",
    secrets: new McpSecretStore(memorySecrets()),
  });
  const saved = await registry.upsert({
    name: "off_server",
    transport: "http",
    enabled: true,
    url: "https://example.com/mcp",
  });
  await registry.setEnabled(saved.id, false);
  assert.deepEqual(await registry.resolveEnabled(), []);
  assert.equal(await registry.hasEnabledUserServer(), false);
});
