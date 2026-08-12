import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { TESTED_GROK_VERSION, detectGrokVersion } from "../src/version.js";

test("缺少 Grok 可执行文件时给出明确结果", async () => {
  const missing = path.join(tmpdir(), "lingdong-not-here", "grok.exe");
  const info = await detectGrokVersion(missing);
  assert.equal(info.exists, false);
  assert.equal(info.tested, false);
  assert.match(info.error ?? "", /未找到/);
});

test("版本号与已测试版本不一致时标记为未测试", async () => {
  const info = await detectGrokVersion(process.execPath);
  assert.equal(info.exists, true);
  assert.ok(info.version, "应能解析出版本号");
  assert.equal(info.tested, info.version === TESTED_GROK_VERSION);
  assert.equal(info.tested, false);
});
