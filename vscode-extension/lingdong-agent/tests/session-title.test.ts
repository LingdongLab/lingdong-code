import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TITLE, MAX_TITLE_CHARS, generateSessionTitle, shouldApplyAutoTitle } from "../src/session-title";

test("从第一条任务提取标题，去掉动作词", () => {
  assert.equal(generateSessionTitle("给首页增加产品介绍区域"), "首页产品介绍区域");
});

test("去掉礼貌用语与人称前缀", () => {
  assert.equal(generateSessionTitle("请帮我把登录页面改成深色主题"), "登录页面改成深色主题");
  assert.equal(generateSessionTitle("我想重构一下用户模块"), "重构一下用户模块");
});

test("只取第一个句子并去掉句末标点", () => {
  assert.equal(generateSessionTitle("修复购物车总价计算错误。另外顺便看一下库存。"), "修复购物车总价计算错误");
  assert.equal(generateSessionTitle("解释一下这个函数的作用？"), "解释一下这个函数的作用");
});

test("换行与多余空白被压平", () => {
  assert.equal(generateSessionTitle("  优化   首屏加载\n速度  "), "优化 首屏加载");
});

test("标题最长 40 个字符", () => {
  const title = generateSessionTitle("整理".repeat(40));
  assert.equal([...title].length, MAX_TITLE_CHARS);
  assert.ok(title.endsWith("…"));
});

test("空输入与纯标点回落到默认标题", () => {
  assert.equal(generateSessionTitle(""), DEFAULT_TITLE);
  assert.equal(generateSessionTitle("？？？"), DEFAULT_TITLE);
  assert.equal(generateSessionTitle("请"), DEFAULT_TITLE);
});

test("标题生成前先脱敏，密钥不会进入会话索引", () => {
  const title = generateSessionTitle("把 api_key=sk-1234567890abcdefghij 换成环境变量");
  assert.ok(!title.includes("sk-1234567890abcdefghij"));
});

test("手动标题不会被自动标题覆盖", () => {
  assert.equal(shouldApplyAutoTitle("manual"), false);
  assert.equal(shouldApplyAutoTitle("auto"), true);
  assert.equal(shouldApplyAutoTitle("placeholder"), true);
});
