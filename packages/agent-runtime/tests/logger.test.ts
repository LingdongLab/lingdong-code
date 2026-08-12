import assert from "node:assert/strict";
import test from "node:test";
import { redactText, redactValue, registerRuntimeSecrets } from "../src/logger.js";

test("日志会隐藏常见 API Key 与授权头", () => {
  assert.equal(redactText("token sk-abcdefghijklmnopqrstuvwxyz"), "token ***REDACTED***");
  assert.equal(redactText("Authorization: Bearer abc.def.ghi"), "Authorization: ***REDACTED***");
  assert.equal(redactText("DEEPSEEK_API_KEY=sk-example-secret"), "DEEPSEEK_API_KEY=***REDACTED***");
});

test("敏感字段递归脱敏", () => {
  const safe = redactValue({ nested: { api_key: "secret", normal: "ok" } }) as { nested: Record<string, string> };
  assert.equal(safe.nested.api_key, "***REDACTED***");
  assert.equal(safe.nested.normal, "ok");
});

test("调用方登记的凭据被整串替换：Key 已不在 process.env 里", () => {
  // 凭据搬进宿主的 SecretStorage 后不再出现在进程环境里，
  // 原先靠读 process.env 拿字面量的那条路径已经失效，必须由调用方登记。
  registerRuntimeSecrets(["gateway-credential-abcdef"]);
  try {
    assert.equal(redactText("headers: gateway-credential-abcdef"), "headers: ***REDACTED***");
    const safe = redactValue({ note: "用了 gateway-credential-abcdef" }) as { note: string };
    assert.equal(safe.note.includes("gateway-credential-abcdef"), false);
  } finally {
    registerRuntimeSecrets([]);
  }
});

test("登记表可被清空，且过短的值不登记", () => {
  registerRuntimeSecrets(["abc"]);
  try {
    assert.equal(redactText("abc def"), "abc def");
  } finally {
    registerRuntimeSecrets([]);
  }
});

test("当前环境变量中的真实格式也会被精确脱敏", () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "nonstandard-local-test-value";
  try {
    assert.equal(redactText("value=nonstandard-local-test-value"), "value=***REDACTED***");
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
});
