import assert from "node:assert/strict";
import test from "node:test";
import {
  CREDENTIAL_DENY_LIST,
  PRIVACY_ENV,
  buildChildEnv,
  injectedCredentialNames,
} from "../src/privacy/runtime-env";

test("父进程里已开启的遥测值被覆盖，而不是沿用", () => {
  const env = buildChildEnv({
    parent: {
      GROK_TELEMETRY_ENABLED: "1",
      GROK_TELEMETRY_TRACE_UPLOAD: "1",
      GROK_TELEMETRY_MIXPANEL_ENABLED: "1",
      GROK_EXTERNAL_OTEL: "1",
      GROK_FEEDBACK_ENABLED: "1",
      GROK_DISABLE_AUTOUPDATER: "0",
      GROK_WEB_FETCH: "1",
    },
  });
  assert.equal(env.GROK_TELEMETRY_ENABLED, "0");
  assert.equal(env.GROK_TELEMETRY_TRACE_UPLOAD, "0");
  assert.equal(env.GROK_TELEMETRY_MIXPANEL_ENABLED, "0");
  assert.equal(env.GROK_EXTERNAL_OTEL, "0");
  assert.equal(env.GROK_FEEDBACK_ENABLED, "0");
  assert.equal(env.GROK_DISABLE_AUTOUPDATER, "1");
  // web_fetch 默认关：不显式写 0 就关不掉（Grok 里它默认开着）。
  assert.equal(env.GROK_WEB_FETCH, "0");
});

test("XAI_API_KEY 与其它模型凭据一律被剥离", () => {
  const parent: NodeJS.ProcessEnv = {};
  for (const name of CREDENTIAL_DENY_LIST) parent[name] = "leaked-value";
  const env = buildChildEnv({ parent });
  for (const name of CREDENTIAL_DENY_LIST) {
    assert.equal(env[name], undefined, `${name} 应被剥离`);
  }
  // 不剥掉 XAI_API_KEY，Grok 的凭据链最后一步就会悄悄回退。
  assert.equal(env.XAI_API_KEY, undefined);
});

test("与模型无关的环境变量原样保留", () => {
  const env = buildChildEnv({
    parent: { PATH: "/usr/bin", MY_PROJECT_TOKEN_PATH: "/tmp/x", NODE_ENV: "test" },
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.MY_PROJECT_TOKEN_PATH, "/tmp/x");
  assert.equal(env.NODE_ENV, "test");
});

test("注入全部传入的凭据，未传入的 Provider 拿不到 Key", () => {
  const env = buildChildEnv({
    parent: {},
    credentials: [
      { name: "LINGDONG_KEY_POE", value: "poe-secret-value" },
      { name: "LINGDONG_KEY_DEEPSEEK", value: "deepseek-secret" },
    ],
  });
  assert.deepEqual(injectedCredentialNames(env), ["LINGDONG_KEY_DEEPSEEK", "LINGDONG_KEY_POE"]);
  assert.equal(env.LINGDONG_KEY_GATEWAY, undefined);
});

test("重建环境时上一次注入的槽位先被清空，禁用的 Provider 不残留", () => {
  const first = buildChildEnv({
    parent: {},
    credentials: [{ name: "LINGDONG_KEY_DEEPSEEK", value: "deepseek-secret" }],
  });
  const second = buildChildEnv({
    parent: first,
    credentials: [{ name: "LINGDONG_KEY_POE", value: "poe-secret" }],
  });
  assert.equal(second.LINGDONG_KEY_DEEPSEEK, undefined);
  assert.equal(second.LINGDONG_KEY_POE, "poe-secret");
  assert.deepEqual(injectedCredentialNames(second), ["LINGDONG_KEY_POE"]);
});

test("重建时清空上一次的 LINGDONG_MCP_* 槽位", () => {
  const first = buildChildEnv({
    parent: {},
    credentials: [{ name: "LINGDONG_MCP_DEMO_API_KEY", value: "mcp-secret" }],
  });
  assert.equal(first.LINGDONG_MCP_DEMO_API_KEY, "mcp-secret");
  const second = buildChildEnv({
    parent: first,
    credentials: [{ name: "LINGDONG_KEY_POE", value: "poe-secret" }],
  });
  assert.equal(second.LINGDONG_MCP_DEMO_API_KEY, undefined);
  assert.equal(second.LINGDONG_KEY_POE, "poe-secret");
});

test("空凭据不写入，避免出现一个空字符串的 Key", () => {
  const env = buildChildEnv({
    parent: {},
    credentials: [{ name: "LINGDONG_KEY_DEEPSEEK", value: "   " }],
  });
  assert.equal(env.LINGDONG_KEY_DEEPSEEK, undefined);
});

test("GROK_MEMORY 两种状态都显式写，父进程里开着的值关得掉", () => {
  const off = buildChildEnv({ parent: { GROK_MEMORY: "1" } });
  assert.equal(off.GROK_MEMORY, "0");
  const on = buildChildEnv({ parent: {}, memoryEnabled: true });
  assert.equal(on.GROK_MEMORY, "1");
});

test("GROK_WEB_FETCH 两种状态都显式写，父进程里开着的值关得掉", () => {
  const off = buildChildEnv({ parent: { GROK_WEB_FETCH: "1" } });
  assert.equal(off.GROK_WEB_FETCH, "0");
  const on = buildChildEnv({ parent: {}, webFetchEnabled: true });
  assert.equal(on.GROK_WEB_FETCH, "1");
});

test("GROK_HOME 指向传入的托管目录", () => {
  const env = buildChildEnv({ parent: { GROK_HOME: "C:/old/home" }, grokHome: "C:/managed/home" });
  assert.equal(env.GROK_HOME, "C:/managed/home");
  assert.equal(Object.keys(PRIVACY_ENV).length > 0, true);
});
