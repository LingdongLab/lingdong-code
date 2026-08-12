import assert from "node:assert/strict";
import test from "node:test";
import { __test as vs } from "./support/vscode-stub";
import type { PrivacyStatusInput } from "../src/privacy/privacy-status";
import {
  SettingsService,
  privacySections,
  type PermissionRulesPort,
} from "../src/services/settings-service";
import type { SettingsHostMessage } from "../src/settings-messages";

/**
 * 设置页宿主服务：配置读写、权限规则、隐私画像。
 *
 * 权限规则这一段以前完全没有界面，只有一个「全部清空」命令，
 * 所以这里的重点是：删单条要真的落盘，并且要同步在跑的 Runtime——
 * 磁盘删了而内存没删，等于这一轮里规则还在生效，用户会以为删除没用。
 */

interface Harness {
  service: SettingsService;
  posts: SettingsHostMessage[];
  rules: PermissionRulesPort;
  removed: { kind: string; value: string }[];
  runtimeCleared: number;
}

function createHarness(
  initial: { kind: string; value: string; label: string }[] = [],
  privacy?: PrivacyStatusInput,
): Harness {
  vs.reset();
  const posts: SettingsHostMessage[] = [];
  const removed: { kind: string; value: string }[] = [];
  let list = [...initial];
  const harness = {
    posts,
    removed,
    runtimeCleared: 0,
  } as Harness;

  const rules: PermissionRulesPort = {
    list: () => list,
    get size() {
      return list.length;
    },
    async remove(kind, value) {
      const before = list.length;
      list = list.filter((rule) => !(rule.kind === kind && rule.value === value));
      if (list.length === before) return false;
      removed.push({ kind, value });
      return true;
    },
    async clear() {
      list = [];
    },
  };
  harness.rules = rules;

  harness.service = new SettingsService({
    ensureStorage: async () => undefined,
    permissionRules: () => rules,
    clearRuntimeSessionRules: () => {
      harness.runtimeCleared += 1;
    },
    privacyInput: async () => privacy ?? {
      profile: undefined,
      keyConfigured: false,
      managedHome: true,
      privacyEnv: {},
      strippedCredentials: [],
    },
    memoryDirectory: () => "C:/store/memory",
    log: () => undefined,
  });
  harness.service.setPoster((message) => posts.push(message));
  return harness;
}

function lastOf<T extends SettingsHostMessage["type"]>(
  posts: SettingsHostMessage[],
  type: T,
): Extract<SettingsHostMessage, { type: T }> | undefined {
  return [...posts].reverse().find((m) => m.type === type) as
    | Extract<SettingsHostMessage, { type: T }>
    | undefined;
}

test("更新设置写进 Global 作用域并回推最新取值", async () => {
  const { service, posts } = createHarness();
  await service.handle({ type: "updateSetting", key: "memory", value: true });

  assert.equal(vs.state.config.get("lingdongAgent.memory"), true);
  assert.equal(lastOf(posts, "config")?.config.memory, true);
});

test("重置设置写回 undefined，让 VS Code 回落到默认值", async () => {
  const { service } = createHarness();
  vs.setConfig("lingdongAgent.snapshotRetentionDays", 7);
  await service.handle({ type: "resetSetting", key: "snapshotRetentionDays" });
  assert.equal(vs.state.config.get("lingdongAgent.snapshotRetentionDays"), undefined);
});

test("字符串列表写入的是可变副本，不是只读数组", async () => {
  const { service } = createHarness();
  await service.handle({
    type: "updateSetting",
    key: "webFetchDomains",
    value: Object.freeze(["x.ai"]),
  });
  const stored = vs.state.config.get("lingdongAgent.webFetchDomains");
  assert.deepEqual(stored, ["x.ai"]);
  assert.ok(Array.isArray(stored) && !Object.isFrozen(stored));
});

test("读取快照跳过类型不对的值，交给界面回落到默认", async () => {
  const { service, posts } = createHarness();
  vs.setConfig("lingdongAgent.memory", "yes");
  vs.setConfig("lingdongAgent.snapshotMaxTotalMb", 256);
  await service.publish();

  const config = lastOf(posts, "config")?.config;
  assert.equal(config?.memory, undefined, "字符串不该被当成布尔塞进去");
  assert.equal(config?.snapshotMaxTotalMb, 256);
});

test("权限规则带上分类中文名与可定位的 id", async () => {
  const { service, posts } = createHarness([
    { kind: "command-prefix", value: "npm test", label: "运行 npm test" },
  ]);
  await service.publishPermissionRules();

  assert.deepEqual(lastOf(posts, "permissionRules")?.rules, [{
    id: "command-prefix\u0000npm test",
    kind: "command-prefix",
    kindLabel: "执行命令",
    value: "npm test",
    label: "运行 npm test",
  }]);
});

test("仓库里混进未知 kind 的规则时跳过，不让界面渲染一条点不动的东西", async () => {
  const { service, posts } = createHarness([
    { kind: "command-prefix", value: "npm test", label: "运行 npm test" },
    { kind: "从旧版本或手工编辑来的", value: "x", label: "x" },
  ]);
  await service.publishPermissionRules();
  assert.equal(lastOf(posts, "permissionRules")?.rules.length, 1);
});

test("删除单条规则会同步清掉 Runtime 内存里的会话规则", async () => {
  const harness = createHarness([
    { kind: "command-prefix", value: "npm test", label: "运行 npm test" },
  ]);
  await harness.service.handle({
    type: "removePermissionRule",
    id: "command-prefix\u0000npm test",
  });

  assert.deepEqual(harness.removed, [{ kind: "command-prefix", value: "npm test" }]);
  assert.equal(harness.runtimeCleared, 1, "只删磁盘不删内存，这一轮里规则还在生效");
  assert.deepEqual(lastOf(harness.posts, "permissionRules")?.rules, []);
});

test("删一条不存在的规则不谎报成功，只重推一次列表", async () => {
  const harness = createHarness([
    { kind: "command-prefix", value: "npm test", label: "运行 npm test" },
  ]);
  await harness.service.handle({ type: "removePermissionRule", id: "read-path\u0000C:/x" });

  assert.equal(harness.runtimeCleared, 0);
  assert.equal(lastOf(harness.posts, "notice"), undefined);
  assert.equal(lastOf(harness.posts, "permissionRules")?.rules.length, 1);
});

test("清空时报出条数；本来就是空的就直说", async () => {
  const withRules = createHarness([
    { kind: "read-path", value: "C:/a", label: "读 C:/a" },
    { kind: "read-path", value: "C:/b", label: "读 C:/b" },
  ]);
  await withRules.service.handle({ type: "clearPermissionRules" });
  assert.match(String(lastOf(withRules.posts, "notice")?.message), /已清空 2 条/);
  assert.equal(withRules.runtimeCleared, 1);

  const empty = createHarness();
  await empty.service.handle({ type: "clearPermissionRules" });
  assert.match(String(lastOf(empty.posts, "notice")?.message), /没有已记住的权限规则/);
  assert.equal(empty.runtimeCleared, 0, "没东西可清就别去动 Runtime");
});

test("选好可执行文件后写进设置并提示重连生效", async () => {
  const { service, posts } = createHarness();
  vs.queueOpenDialog([{ fsPath: "E:/grok/grok.exe" }]);
  await service.handle({ type: "pickGrokExecutable" });

  assert.equal(vs.state.config.get("lingdongAgent.grokExecutable"), "E:/grok/grok.exe");
  assert.match(String(lastOf(posts, "notice")?.message), /重连后生效/);
});

test("取消选择文件时什么都不写", async () => {
  const { service, posts } = createHarness();
  vs.queueOpenDialog(undefined);
  await service.handle({ type: "pickGrokExecutable" });

  assert.equal(vs.state.config.has("lingdongAgent.grokExecutable"), false);
  assert.equal(lastOf(posts, "notice"), undefined);
});

test("未连接时隐私画像如实说未连接，而不是把设置当成运行状态", () => {
  const sections = privacySections({
    profile: undefined,
    keyConfigured: false,
    managedHome: true,
    privacyEnv: {},
    strippedCredentials: [],
  });
  const model = sections.find((s) => s.title === "当前模型");
  assert.deepEqual(model?.rows, []);
  assert.match(String(model?.note), /尚未连接/);

  const channels = sections.find((s) => s.title === "网络通道");
  assert.equal(channels?.rows[0]?.tone, "unknown");
});

test("通道开着标 warn、关着标 ok；托管目录关掉时状态记为未知", () => {
  const profile = {
    providerId: "poe",
    providerName: "Poe",
    modelName: "GPT-4o",
    modelId: "gpt-4o",
    baseUrlHost: "api.poe.com",
    protocol: "chat_completions",
    envKeyName: "POE_API_KEY",
    startedAt: 1_700_000_000_000,
    channels: {
      telemetry: false,
      traceUpload: false,
      mixpanel: false,
      externalOtel: false,
      feedback: false,
      autoUpdate: true,
      remoteFetch: false,
      webFetch: false,
    },
  } as unknown as PrivacyStatusInput["profile"];

  const managed = privacySections({
    profile,
    keyConfigured: true,
    managedHome: true,
    privacyEnv: { GROK_TELEMETRY: "0" },
    strippedCredentials: ["OPENAI_API_KEY"],
  });
  const channels = managed.find((s) => s.title === "网络通道");
  assert.equal(channels?.rows.find((r) => r.label === "遥测")?.tone, "ok");
  assert.equal(channels?.rows.find((r) => r.label === "自动更新")?.tone, "warn");
  assert.ok(channels?.rows.some((r) => r.label === "宿主侧 Web Fetch"));

  const unmanaged = privacySections({
    profile,
    keyConfigured: true,
    managedHome: false,
    privacyEnv: {},
    strippedCredentials: [],
  });
  const source = unmanaged.find((s) => s.title === "配置来源");
  assert.equal(source?.rows.find((r) => r.label === "托管 GROK_HOME")?.tone, "warn");
  assert.match(String(source?.note), /无法保证/);
});

test("凭据段永远只说配没配，不出现 Key 本身", () => {
  const sections = privacySections({
    profile: undefined,
    keyConfigured: true,
    managedHome: true,
    privacyEnv: {},
    strippedCredentials: ["OPENAI_API_KEY"],
  });
  const credentials = sections.find((s) => s.title === "凭据");
  assert.equal(credentials?.rows.find((r) => r.label === "API Key")?.value, "已配置");
  assert.ok(credentials?.rows.some((r) => r.label === "已从子进程环境剥离"));
});

test("publish 一次把配置、记忆目录、权限规则与隐私画像都推齐", async () => {
  const { service, posts } = createHarness([
    { kind: "read-path", value: "C:/a", label: "读 C:/a" },
  ]);
  await service.publish();

  for (const type of ["config", "memoryDirectory", "permissionRules", "privacy"] as const) {
    assert.ok(lastOf(posts, type), `${type} 没推出去，对应分类会停在空白上`);
  }
  assert.equal(lastOf(posts, "memoryDirectory")?.directory, "C:/store/memory");
});
