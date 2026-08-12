/**
 * 目录缓存的行为测试。
 *
 * 缓存要证明的是两件事：命中时真的不发请求（省的是用户的额度），
 * 以及刷新失败时旧数据还在（用户不会因为一次网络抖动就丢掉整份列表）。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { CATALOG_TTL_MS } from "../src/models/providers/poe-catalog";
import { createSettingsHarness } from "./support/model-settings-harness";
import { __test as vscodeHarness } from "./support/vscode-stub";

const KEY = "poe-key-0123456789abcdef";

const CATALOG_BODY = JSON.stringify({
  data: [
    { id: "Claude-Sonnet-4.5", owned_by: "anthropic", supported_endpoints: ["/v1/responses"] },
    { id: "GPT-4o-mini", owned_by: "openai", supported_endpoints: ["/v1/chat/completions"] },
  ],
});

/** 一个装好 Poe 且填过 Key 的测试台；时钟由测试推进。 */
async function poeHarness(clock: { value: number }, body = CATALOG_BODY) {
  const harness = await createSettingsHarness({
    routes: { "/models": { status: 200, body } },
    now: () => clock.value,
  });
  await harness.send({ type: "addBuiltinProvider", providerId: "poe" });
  await harness.send({ type: "saveKey", providerId: "poe", key: KEY });
  return harness;
}

function catalogRequests(harness: Awaited<ReturnType<typeof poeHarness>>): number {
  return harness.requests.filter((request) => request.url.endsWith("/models")).length;
}

test("首次同步拉网络，缓存未过期时一个请求都不发", async () => {
  const clock = { value: 1_000_000 };
  const harness = await poeHarness(clock);

  await harness.send({ type: "syncCatalog", providerId: "poe", force: false });
  assert.equal(catalogRequests(harness), 1);
  const first = harness.messagesOfType("catalog").at(-1);
  assert.equal(first?.catalog.entries.length, 2);
  assert.equal(first?.catalog.fromCache, false);

  clock.value += 60_000;
  await harness.send({ type: "syncCatalog", providerId: "poe", force: false });

  assert.equal(catalogRequests(harness), 1);
  const second = harness.messagesOfType("catalog").at(-1);
  assert.equal(second?.catalog.fromCache, true);
  assert.equal(second?.catalog.entries.length, 2);
});

test("超过 12 小时后重新拉取", async () => {
  const clock = { value: 1_000_000 };
  const harness = await poeHarness(clock);

  await harness.send({ type: "syncCatalog", providerId: "poe", force: false });
  clock.value += CATALOG_TTL_MS + 1;
  await harness.send({ type: "syncCatalog", providerId: "poe", force: false });

  assert.equal(catalogRequests(harness), 2);
  assert.equal(harness.messagesOfType("catalog").at(-1)?.catalog.fromCache, false);
});

test("force 绕过未过期的缓存", async () => {
  const clock = { value: 1_000_000 };
  const harness = await poeHarness(clock);

  await harness.send({ type: "syncCatalog", providerId: "poe", force: false });
  await harness.send({ type: "syncCatalog", providerId: "poe", force: true });

  assert.equal(catalogRequests(harness), 2);
});

test("刷新失败保留旧缓存，并按错误码给提示", async () => {
  const clock = { value: 1_000_000 };
  let status = 200;
  const harness = await createSettingsHarness({
    transport: () => Promise.resolve({ status, headers: {}, body: status === 200 ? CATALOG_BODY : "{}" }),
    now: () => clock.value,
  });
  await harness.send({ type: "addBuiltinProvider", providerId: "poe" });
  await harness.send({ type: "saveKey", providerId: "poe", key: KEY });
  await harness.send({ type: "syncCatalog", providerId: "poe", force: false });

  status = 500;
  await harness.send({ type: "syncCatalog", providerId: "poe", force: true });

  // 界面照常拿到条目，只是标着来自缓存，外加一条错误说明。
  const latest = harness.messagesOfType("catalog").at(-1);
  assert.equal(latest?.catalog.entries.length, 2);
  assert.equal(latest?.catalog.fromCache, true);
  assert.ok(harness.messagesOfType("error").at(-1)?.message.includes("暂时不可用"));
  assert.ok(await harness.catalog.read("poe"));
});

test("没有 Key 时不发请求，只提示先配置", async () => {
  const clock = { value: 1_000_000 };
  const harness = await createSettingsHarness({
    routes: { "/models": { status: 200, body: CATALOG_BODY } },
    now: () => clock.value,
  });
  await harness.send({ type: "addBuiltinProvider", providerId: "poe" });

  await harness.send({ type: "syncCatalog", providerId: "poe", force: false });

  assert.equal(catalogRequests(harness), 0);
  assert.ok(harness.messagesOfType("error").at(-1)?.message.includes("API Key"));
});

test("缓存文件里只有公开目录，没有任何凭据", async () => {
  const clock = { value: 1_000_000 };
  const harness = await poeHarness(clock);
  await harness.send({ type: "syncCatalog", providerId: "poe", force: false });

  const file = path.join(harness.storageRoot, "agent-providers", "catalogs", "poe.json");
  const raw = await readFile(file, "utf8");

  assert.ok(raw.includes("Claude-Sonnet-4.5"));
  assert.equal(raw.includes(KEY), false);
  assert.equal(/api[_-]?key|authorization|secret/i.test(raw), false);
});

test("删除 Provider 连带删掉目录缓存文件", async () => {
  const clock = { value: 1_000_000 };
  const harness = await poeHarness(clock);
  await harness.send({ type: "syncCatalog", providerId: "poe", force: false });
  assert.ok(await harness.catalog.read("poe"));

  vscodeHarness.queueWarning("确认删除");
  await harness.send({ type: "deleteProvider", providerId: "poe" });

  assert.equal(harness.providers.registry.get("poe"), undefined);
  assert.equal(await harness.catalog.read("poe"), undefined);
});

test("升级前的缓存（模态未拆分）直接重拉，不会拿旧结构判能不能看图", async () => {
  const clock = { value: 1_000_000 };
  const harness = await poeHarness(clock);
  const file = path.join(harness.storageRoot, "agent-providers", "catalogs", "poe.json");
  await harness.catalog.write("poe", { entries: [], syncedAt: clock.value });

  // 手写一份升级前的缓存：只有合并后的 modalities，判不出这个模型收不收图。
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      kind: "catalog",
      updatedAt: clock.value,
      data: {
        syncedAt: clock.value,
        entries: [{ id: "Claude-Sonnet-4.5", vendor: "anthropic", modalities: ["text", "image"] }],
      },
    }),
  );

  assert.equal(await harness.catalog.read("poe"), undefined);

  // 时钟没走，但旧结构不复用，用户不用等 12 小时才拿到真实模态。
  await harness.send({ type: "syncCatalog", providerId: "poe", force: false });

  assert.equal(catalogRequests(harness), 1);
  const view = harness.messagesOfType("catalog").at(-1)?.catalog;
  assert.equal(view?.fromCache, false);
  assert.equal(view?.entries.length, 2);
});

test("损坏的缓存文件不会让同步失败，只是回落到重新拉取", async () => {
  const clock = { value: 1_000_000 };
  const harness = await poeHarness(clock);
  await harness.catalog.write("poe", { entries: [], syncedAt: clock.value });

  // 直接写坏文件，模拟磁盘异常或人工编辑。
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(harness.storageRoot, "agent-providers", "catalogs", "poe.json"), "{ broken");

  await harness.send({ type: "syncCatalog", providerId: "poe", force: false });

  assert.equal(catalogRequests(harness), 1);
  assert.equal(harness.messagesOfType("catalog").at(-1)?.catalog.entries.length, 2);
});
