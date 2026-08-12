import assert from "node:assert/strict";
import test from "node:test";
import { describeDataDestination, validateBaseUrl } from "../src/models/providers/provider-validator";

test("远程地址必须是 https，http 直接拒绝", () => {
  const result = validateBaseUrl("http://api.example.com/v1");
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : "", "insecure-remote");
});

test("localhost 与回环地址允许走 http", () => {
  for (const url of [
    "http://localhost:11434/v1",
    "http://127.0.0.1:1234/v1",
    "http://127.5.5.5:8080",
    "http://[::1]:8000/v1",
  ]) {
    const result = validateBaseUrl(url);
    assert.equal(result.ok, true, `${url} 应被放行`);
    assert.equal(result.ok === true ? result.local : false, true);
  }
});

test("地址里夹带用户名密码被拒绝", () => {
  const result = validateBaseUrl("https://user:pass@api.example.com/v1");
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : "", "embedded-credentials");
});

test("Query 里放凭据被拒绝：Query 会进会话记录", () => {
  for (const url of [
    "https://api.example.com/v1?api_key=sk-abc",
    "https://api.example.com/v1?token=abc",
    "https://api.example.com/v1?KEY=abc",
  ]) {
    const result = validateBaseUrl(url);
    assert.equal(result.ok, false, `${url} 应被拒绝`);
    assert.equal(result.ok === false ? result.reason : "", "secret-in-query");
  }
});

test("尾斜杠被规范化，避免拼出双斜杠路径", () => {
  const result = validateBaseUrl("https://api.example.com/v1///");
  assert.equal(result.ok === true ? result.normalized : "", "https://api.example.com/v1");
});

test("非法 URL 与非 http 协议分别给出各自的原因", () => {
  assert.equal(validateBaseUrl("").ok, false);
  const empty = validateBaseUrl("");
  assert.equal(empty.ok === false ? empty.reason : "", "empty");

  const invalid = validateBaseUrl("api.example.com/v1");
  assert.equal(invalid.ok === false ? invalid.reason : "", "invalid-url");

  const scheme = validateBaseUrl("ftp://api.example.com");
  assert.equal(scheme.ok === false ? scheme.reason : "", "unsupported-scheme");
});

test("保存前的提示明确说出数据发送域名", () => {
  const result = validateBaseUrl("https://api.example.com/v1");
  assert.equal(result.ok, true);
  const host = result.ok ? result.host : "";
  assert.equal(host, "api.example.com");
  assert.ok(describeDataDestination(host).includes("api.example.com"));
});
