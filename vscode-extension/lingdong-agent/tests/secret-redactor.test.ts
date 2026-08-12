import assert from "node:assert/strict";
import test from "node:test";
import {
  REDACTED,
  clearSecretLiterals,
  redact,
  redactUnknown,
  redactingLogger,
  registerSecretLiterals,
} from "../src/privacy/secret-redactor";
import { sanitizeEntry } from "../src/storage/transcript-repository";

test("Authorization Bearer 头被脱敏", () => {
  const output = redact("curl -H 'Authorization: Bearer abc123def456' https://api.example.com");
  assert.equal(output.includes("abc123def456"), false);
  assert.ok(output.includes(REDACTED));
});

test("Cookie 与 Set-Cookie 整行脱敏", () => {
  assert.equal(redact("Cookie: session=abc123; other=def").includes("abc123"), false);
  assert.equal(redact("set-cookie: token=xyz789; Path=/").includes("xyz789"), false);
});

test("URL 查询串里的 key 与 token 被脱敏", () => {
  const output = redact("GET https://api.example.com/v1/models?api_key=abcdef123456&token=zzz");
  assert.equal(output.includes("abcdef123456"), false);
  assert.equal(output.includes("zzz"), false);
  assert.ok(output.includes("api_key=***"));
});

test("不只认 sk- 前缀：字段名匹配也生效", () => {
  clearSecretLiterals();
  const output = redact('{"api_key":"deepseek-99887766","access_token":"tok-abcdef"}');
  assert.equal(output.includes("deepseek-99887766"), false);
  assert.equal(output.includes("tok-abcdef"), false);
});

test("已登记的凭据字面量整串替换，哪怕出现在毫无格式的文本里", () => {
  registerSecretLiterals(["zzqq-my-gateway-credential"]);
  const output = redact("连接失败，实际请求头包含 zzqq-my-gateway-credential 请检查");
  assert.equal(output.includes("zzqq-my-gateway-credential"), false);
  clearSecretLiterals();
});

test("过短的字符串不登记，避免把正常文本打成马赛克", () => {
  registerSecretLiterals(["abc"]);
  assert.equal(redact("abc def"), "abc def");
  clearSecretLiterals();
});

test("Output Channel 落点：包裹后的 logger 每一行都过脱敏", () => {
  registerSecretLiterals(["sk-output-channel-secret"]);
  const lines: string[] = [];
  const log = redactingLogger((line) => lines.push(line));
  log("[startup] key=sk-output-channel-secret");
  assert.equal(lines[0]?.includes("sk-output-channel-secret"), false);
  clearSecretLiterals();
});

test("transcript 落点：错误条目落盘前已脱敏", () => {
  registerSecretLiterals(["sk-transcript-secret-value"]);
  const entry = sanitizeEntry({
    kind: "error",
    at: 1,
    message: "请求失败：Authorization: Bearer sk-transcript-secret-value",
  });
  assert.equal(entry.kind === "error" ? entry.message.includes("sk-transcript-secret-value") : true, false);
  clearSecretLiterals();
});

test("Timeline 落点：工具明细里的凭据不落盘", () => {
  registerSecretLiterals(["poe-timeline-secret-key"]);
  const entry = sanitizeEntry({
    kind: "tool",
    at: 1,
    toolCallId: "call-1",
    toolKind: "execute",
    label: "运行命令",
    readOnly: false,
    status: "failed",
    output: "curl -H 'Authorization: Bearer poe-timeline-secret-key' 失败",
  });
  const output = entry.kind === "tool" ? entry.output ?? "" : "";
  assert.equal(output.includes("poe-timeline-secret-key"), false);
  clearSecretLiterals();
});

test("结构化数据递归脱敏，同时不改变结构", () => {
  clearSecretLiterals();
  const output = redactUnknown({
    headers: { authorization: "Bearer abc123def456" },
    items: ["api_key=xyz987654", 42, true],
  }) as { headers: { authorization: string }; items: unknown[] };
  assert.equal(output.headers.authorization.includes("abc123def456"), false);
  assert.equal(String(output.items[0]).includes("xyz987654"), false);
  assert.equal(output.items[1], 42);
  assert.equal(output.items[2], true);
});
