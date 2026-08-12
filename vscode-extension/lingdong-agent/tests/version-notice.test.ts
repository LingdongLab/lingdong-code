import assert from "node:assert/strict";
import test from "node:test";
import { buildVersionNotice } from "../src/version-notice";

const TESTED = "0.2.118";

test("已测试版本给出普通提示", () => {
  const notice = buildVersionNotice(
    { executable: "grok.exe", exists: true, version: "0.2.118", tested: true },
    TESTED,
  );
  assert.equal(notice.level, "info");
  assert.match(notice.message, /0\.2\.118/);
});

test("未测试版本给出兼容性警告并同时列出两个版本", () => {
  const notice = buildVersionNotice(
    { executable: "grok.exe", exists: true, version: "0.2.120", tested: false },
    TESTED,
  );
  assert.equal(notice.level, "warn");
  assert.match(notice.message, /尚未经过兼容性测试/);
  assert.match(notice.message, /0\.2\.118/);
  assert.match(notice.message, /0\.2\.120/);
});

test("缺少可执行文件时直接给出错误原因", () => {
  const notice = buildVersionNotice(
    { executable: "E:\\缺失\\grok.exe", exists: false, tested: false, error: "未找到 Grok 可执行文件：E:\\缺失\\grok.exe" },
    TESTED,
  );
  assert.equal(notice.level, "warn");
  assert.match(notice.message, /未找到/);
});
