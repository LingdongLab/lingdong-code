import assert from "node:assert/strict";
import test from "node:test";
import {
  looksBinaryText,
  matchDroppedName,
  normalizeDropText,
  parseFileUriList,
} from "../src/dropped-file";

// ---------------------------------------------------------------------------
// normalizeDropText：磁盘 CRLF 与拖入 LF 必须比得上
// ---------------------------------------------------------------------------

test("归一化：去 BOM、CRLF 统一为 LF", () => {
  assert.equal(normalizeDropText("\uFEFFa\r\nb\r\nc"), "a\nb\nc");
  assert.equal(normalizeDropText("a\nb"), "a\nb");
});

// ---------------------------------------------------------------------------
// looksBinaryText
// ---------------------------------------------------------------------------

test("NUL 字节即二进制", () => {
  assert.equal(looksBinaryText("PK\u0000\u0003"), true);
});

test("零星替换符不算二进制，密集才算", () => {
  assert.equal(looksBinaryText(`${"正常文本".repeat(100)}\uFFFD`), false);
  assert.equal(looksBinaryText("\uFFFD\uFFFD\uFFFD\uFFFDab"), true);
});

test("普通代码文本不是二进制", () => {
  assert.equal(looksBinaryText("export const a = 1;\n"), false);
  assert.equal(looksBinaryText(""), false);
});

// ---------------------------------------------------------------------------
// matchDroppedName：按文件名找仓库候选
// ---------------------------------------------------------------------------

const FILES = [
  "src/index.ts",
  "src/utils/index.ts",
  "docs/README.md",
  "models.html",
];

test("唯一命中返回那一个", () => {
  assert.deepEqual(matchDroppedName(FILES, "models.html"), ["models.html"]);
  assert.deepEqual(matchDroppedName(FILES, "README.md"), ["docs/README.md"]);
});

test("同名多个全部返回，交给内容比对", () => {
  assert.deepEqual(matchDroppedName(FILES, "index.ts"), ["src/index.ts", "src/utils/index.ts"]);
});

test("Windows 下大小写不敏感", () => {
  assert.deepEqual(matchDroppedName(FILES, "MODELS.HTML"), ["models.html"]);
});

test("找不到与空名字都返回空", () => {
  assert.deepEqual(matchDroppedName(FILES, "nope.txt"), []);
  assert.deepEqual(matchDroppedName(FILES, "  "), []);
});

// ---------------------------------------------------------------------------
// parseFileUriList
// ---------------------------------------------------------------------------

test("uri-list 只取 file:// 行，注释与空行跳过", () => {
  const raw = "# comment\r\nfile:///e:/repo/a.ts\r\n\r\nhttps://example.com\nFILE:///e:/repo/b.ts";
  assert.deepEqual(parseFileUriList(raw), ["file:///e:/repo/a.ts", "FILE:///e:/repo/b.ts"]);
});

test("空串返回空数组", () => {
  assert.deepEqual(parseFileUriList(""), []);
});
