import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createNodeFileSystem } from "../src/file-system-port";
import { secretIdFor } from "../src/models/providers/provider-types";
import { JsonStore } from "../src/storage/json-store";
import { SessionRepository } from "../src/storage/session-repository";
import {
  CHAT_OK,
  createSettingsHarness,
  fakeSession,
} from "./support/model-settings-harness";
import { __test as vscodeHarness } from "./support/vscode-stub";

const draft = {
  displayName: "My Gateway",
  baseUrl: "https://api.example.com/v1",
  protocol: "chat_completions" as const,
  remoteModelId: "qwen2.5-coder",
};

const PROVIDER_ID = "my-gateway";
const MODEL_ID = "my-gateway:qwen2.5-coder";
const KEY = "sk-gateway-must-be-removed-0123456789";

async function harnessWithCustomProvider() {
  const harness = await createSettingsHarness({ routes: { "/chat/completions": CHAT_OK } });
  vscodeHarness.queueWarning("确认添加");
  await harness.send({ type: "addCustomProvider", draft });
  await harness.send({ type: "saveKey", providerId: PROVIDER_ID, key: KEY });
  return harness;
}

test("findByModelId 精确匹配，不是模糊搜索", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lingdong-delete-"));
  const fs = createNodeFileSystem();
  const repo = new SessionRepository(root, "ws-a", fs, new JsonStore(fs));

  await repo.create({ modelId: "deepseek-v4-flash", localMode: "ask" });
  const target = await repo.create({ modelId: MODEL_ID, localMode: "ask" });
  await repo.create({ modelId: MODEL_ID, localMode: "agent" });

  const found = await repo.findByModelId(MODEL_ID);
  assert.equal(found.length, 2);
  assert.ok(found.some((record) => record.id === target.id));
  assert.equal(found.every((record) => record.modelId === MODEL_ID), true);

  // 前缀相同但不是同一个模型，不能被算进去。
  assert.deepEqual(await repo.findByModelId("my-gateway:qwen2.5"), []);
  assert.deepEqual(await repo.findByModelId("deepseek"), []);
});

test("有会话引用时先确认，取消就什么都不做", async () => {
  const harness = await harnessWithCustomProvider();
  harness.sessions.set(MODEL_ID, [fakeSession("ses-1", MODEL_ID), fakeSession("ses-2", MODEL_ID)]);

  await harness.send({ type: "deleteModel", providerId: PROVIDER_ID, modelId: MODEL_ID });

  const warned = vscodeHarness.state.messages.filter((entry) => entry.level === "warn").at(-1);
  assert.ok(warned, "应当弹出确认");
  assert.ok(warned.text.includes("有 2 个会话正在使用此模型"));
  assert.ok(warned.text.includes("需要重新选择模型"));
  // 没排队答复 = 用户点了取消。
  assert.equal(harness.providers.registry.get(PROVIDER_ID)?.models.length, 1);
});

test("确认后删模型，但会话记录一条不动", async () => {
  const harness = await harnessWithCustomProvider();
  const referencing = [fakeSession("ses-1", MODEL_ID)];
  harness.sessions.set(MODEL_ID, referencing);
  vscodeHarness.queueWarning("仍然删除");

  await harness.send({ type: "deleteModel", providerId: PROVIDER_ID, modelId: MODEL_ID });

  assert.equal(harness.providers.registry.get(PROVIDER_ID)?.models.length, 0);
  // 会话既没被删，也没被改成别的模型。
  assert.equal(referencing.length, 1);
  assert.equal(referencing[0]!.modelId, MODEL_ID);
});

test("无人引用的模型直接删除，不打扰用户", async () => {
  const harness = await harnessWithCustomProvider();
  await harness.send({ type: "deleteModel", providerId: PROVIDER_ID, modelId: MODEL_ID });

  assert.equal(harness.providers.registry.get(PROVIDER_ID)?.models.length, 0);
  assert.equal(vscodeHarness.state.messages.filter((entry) => entry.level === "warn").length, 1,
    "只应有添加服务商时的那一次确认");
});

test("删除 Provider 连带清掉 SecretStorage 里的凭据", async () => {
  const harness = await harnessWithCustomProvider();
  const secretKey = `lingdongAgent.providerKey.${PROVIDER_ID}`;
  assert.equal(vscodeHarness.state.secrets.get(secretKey), KEY);
  assert.equal(secretIdFor(PROVIDER_ID), secretKey);

  vscodeHarness.queueWarning("确认删除");
  await harness.send({ type: "deleteProvider", providerId: PROVIDER_ID });

  assert.equal(harness.providers.registry.get(PROVIDER_ID), undefined);
  assert.equal(vscodeHarness.state.secrets.get(secretKey), undefined);
  // 非敏感索引也要跟着收缩，否则界面会一直显示「已配置」。
  const index = vscodeHarness.state.globalState.get("lingdongAgent.providerKeyIndex") as string[];
  assert.equal(index.includes(PROVIDER_ID), false);
});

test("删除 Provider 的确认文案会说明受影响的会话数", async () => {
  const harness = await harnessWithCustomProvider();
  harness.sessions.set(MODEL_ID, [fakeSession("ses-1", MODEL_ID)]);
  vscodeHarness.queueWarning("确认删除");

  await harness.send({ type: "deleteProvider", providerId: PROVIDER_ID });

  const warned = vscodeHarness.state.messages.filter((entry) => entry.level === "warn").at(-1);
  assert.ok(warned, "应当弹出确认");
  assert.ok(warned.text.includes("有 1 个会话正在使用"));
  assert.ok(warned.text.includes("API Key"));
  // 会话本身不受影响，只是下次需要重新选模型。
  assert.equal(harness.messagesOfType("notice").at(-1)?.message.includes("会话记录保持不变"), true);
});

test("内置服务商不允许删除，凭据也留在原处", async () => {
  const harness = await createSettingsHarness();
  await harness.send({ type: "saveKey", providerId: "deepseek", key: "sk-deepseek-0123456789" });

  await harness.send({ type: "deleteProvider", providerId: "deepseek" });

  assert.ok(harness.messagesOfType("error").at(-1)?.message.includes("内置服务商"));
  assert.ok(harness.providers.registry.get("deepseek"));
  assert.equal(
    vscodeHarness.state.secrets.get("lingdongAgent.providerKey.deepseek"),
    "sk-deepseek-0123456789",
  );
});

test("删除凭据不会连带删掉 Provider 或它的模型", async () => {
  const harness = await harnessWithCustomProvider();
  await harness.send({ type: "deleteKey", providerId: PROVIDER_ID });

  assert.equal(vscodeHarness.state.secrets.get(`lingdongAgent.providerKey.${PROVIDER_ID}`), undefined);
  const provider = harness.providers.registry.get(PROVIDER_ID);
  assert.ok(provider);
  assert.equal(provider.models.length, 1);
  // 配置还在，只是缺凭据；Composer 侧会因此不展示，而不是静默换一个。
  assert.equal(harness.latestProviders()?.providers.find((view) => view.id === PROVIDER_ID)?.keyConfigured, false);
});
