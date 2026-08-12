import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderSecretStore,
  type SecretIndexPort,
  type SecretStoragePort,
} from "../src/models/providers/provider-secret-store";
import { secretIdFor } from "../src/models/providers/provider-types";

interface Harness {
  store: ProviderSecretStore;
  secrets: Map<string, string>;
  index: string[];
  reads: string[];
}

function createHarness(): Harness {
  const secrets = new Map<string, string>();
  const reads: string[] = [];
  let index: string[] = [];

  const secretsPort: SecretStoragePort = {
    get(key) {
      reads.push(key);
      return Promise.resolve(secrets.get(key));
    },
    store(key, value) {
      secrets.set(key, value);
      return Promise.resolve();
    },
    delete(key) {
      secrets.delete(key);
      return Promise.resolve();
    },
  };
  const indexPort: SecretIndexPort = {
    get: () => index,
    set: (ids) => {
      index = [...ids];
      return Promise.resolve();
    },
  };

  const harness: Harness = {
    store: new ProviderSecretStore(secretsPort, indexPort),
    secrets,
    get index() { return index; },
    reads,
  } as Harness;
  return harness;
}

test("Key 写进 SecretStorage 的命名空间键位", async () => {
  const harness = createHarness();
  await harness.store.saveKey("deepseek", "sk-real-deepseek-key-abcdef");
  assert.equal(harness.secrets.get(secretIdFor("deepseek")), "sk-real-deepseek-key-abcdef");
  assert.equal(await harness.store.getKey("deepseek"), "sk-real-deepseek-key-abcdef");
});

test("hasKey 只查索引，不读明文", async () => {
  const harness = createHarness();
  await harness.store.saveKey("deepseek", "sk-real-deepseek-key-abcdef");
  harness.reads.length = 0;

  assert.equal(harness.store.hasKey("deepseek"), true);
  assert.equal(harness.store.hasKey("poe"), false);
  // 回答「是否已配置」不该把凭据拉进内存。
  assert.deepEqual(harness.reads, []);
});

test("没有 getAllKeys 这样的批量导出入口", () => {
  const harness = createHarness();
  const surface = harness.store as unknown as Record<string, unknown>;
  assert.equal("getAllKeys" in surface, false);
  assert.equal(typeof surface.getAllKeys, "undefined");
});

test("删除后索引与存储同时清空", async () => {
  const harness = createHarness();
  await harness.store.saveKey("deepseek", "sk-real-deepseek-key-abcdef");
  await harness.store.deleteKey("deepseek");
  assert.equal(harness.secrets.has(secretIdFor("deepseek")), false);
  assert.equal(harness.store.hasKey("deepseek"), false);
  assert.equal(await harness.store.getKey("deepseek"), undefined);
});

test("空字符串等于删除，不会存一个空凭据", async () => {
  const harness = createHarness();
  await harness.store.saveKey("deepseek", "sk-real-deepseek-key-abcdef");
  await harness.store.saveKey("deepseek", "   ");
  assert.equal(harness.store.hasKey("deepseek"), false);
});

test("reconcile 会修掉索引虚高：外部清空 SecretStorage 后不再谎报已配置", async () => {
  const harness = createHarness();
  await harness.store.saveKey("deepseek", "sk-real-deepseek-key-abcdef");
  harness.secrets.clear();
  assert.equal(harness.store.hasKey("deepseek"), true, "校准前索引仍然虚高");

  await harness.store.reconcile(["deepseek", "poe"]);
  assert.equal(harness.store.hasKey("deepseek"), false);
});

test("secretLiterals 只返回真实存在的凭据，供脱敏器登记", async () => {
  const harness = createHarness();
  await harness.store.saveKey("deepseek", "sk-real-deepseek-key-abcdef");
  await harness.store.saveKey("poe", "poe-key-0123456789");
  assert.deepEqual(
    (await harness.store.secretLiterals()).sort(),
    ["poe-key-0123456789", "sk-real-deepseek-key-abcdef"],
  );
});
