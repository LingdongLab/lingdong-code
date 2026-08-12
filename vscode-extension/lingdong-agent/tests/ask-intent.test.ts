import assert from "node:assert/strict";
import test from "node:test";
import { detectWriteIntent } from "../src/ask-intent";

test("常见修改类表述会被识别", () => {
  assert.equal(detectWriteIntent("把首页标题改成灵动 Code").matched, true);
  assert.equal(detectWriteIntent("帮我新建一个配置文件").matched, true);
  assert.equal(detectWriteIntent("删除无用的样式").matched, true);
  assert.equal(detectWriteIntent("安装 lodash 依赖").matched, true);
  assert.equal(detectWriteIntent("提交代码到主分支").matched, true);
  assert.equal(detectWriteIntent("执行命令跑一下构建").matched, true);
});

test("纯分析请求不会被拦截", () => {
  assert.equal(detectWriteIntent("用中文分析当前项目结构").matched, false);
  assert.equal(detectWriteIntent("解释一下这个函数的作用").matched, false);
  assert.equal(detectWriteIntent("列出所有页面文件").matched, false);
});

test("否定从句不会造成误判", () => {
  assert.equal(detectWriteIntent("只读取并列出当前项目文件，不要修改任何文件").matched, false);
  assert.equal(detectWriteIntent("分析实现方式，无需创建新文件").matched, false);
  assert.equal(detectWriteIntent("请勿删除任何内容，只做说明").matched, false);
});

test("命中时给出原因和关键词", () => {
  const intent = detectWriteIntent("把 index.html 的标题改成新的");
  assert.equal(intent.matched, true);
  assert.ok(intent.reason && intent.reason.length > 0);
  assert.equal(intent.keyword, "改成");
});

test("空输入不算写入意图", () => {
  assert.equal(detectWriteIntent("").matched, false);
  assert.equal(detectWriteIntent("   ").matched, false);
});
