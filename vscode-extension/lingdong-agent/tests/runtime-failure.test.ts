/**
 * Runtime 错误的可读化。
 *
 * 对着一次真实故障写的：切到某个 Poe 模型后每一轮都失败，
 * 用户能看到的只有「操作未成功，详情见输出日志」，日志里也只有
 * `ACP -32603: Internal error`。原因其实一直躺在 JSON-RPC 错误的 data 里。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { describeRuntimeFailure } from "../src/runtime-failure";
import { isDisplayNoise } from "../src/webview/message-renderer";

const REAL = "ACP -32603: Internal error — serialization error: "
  + "invalid type: null, expected u32 at line 1 column 334";

test("数值字段返回 null：说清是模型响应的问题，并让用户换模型", () => {
  const message = describeRuntimeFailure(REAL, { modelId: "poe:kimi-k3" });

  assert.ok(message.includes("poe:kimi-k3"), "要指名是哪个模型");
  assert.ok(message.includes("数值字段返回了 null"));
  assert.ok(message.includes("换一个模型"), "重试同一个模型不会有不同结果");
  // 行号列号对用户没有意义。
  assert.equal(message.includes("column 334"), false);
});

test("不知道当前模型时也给得出话", () => {
  const message = describeRuntimeFailure(REAL);
  assert.ok(message.includes("当前模型"));
  assert.ok(message.includes("换一个模型"));
});

test("其它序列化错误保留原始描述，不硬套成 null 那一种", () => {
  const message = describeRuntimeFailure(
    "ACP -32603: Internal error — serialization error: missing field `choices` at line 1 column 12",
    { modelId: "poe:some-model" },
  );
  assert.ok(message.includes("missing field `choices`"));
  assert.ok(message.includes("换一个模型"));
});

test("不认识的错误原样返回，不吞掉信息", () => {
  assert.equal(describeRuntimeFailure("连接被重置"), "连接被重置");
  assert.equal(describeRuntimeFailure("  超时  "), "超时");
});

test("翻译后的文案不会再被界面当成噪音过滤掉", () => {
  // 原文里带 ACP 字样，会被 isDisplayNoise 判成噪音后替换成一句无用的兜底。
  assert.equal(isDisplayNoise(REAL), true);
  assert.equal(isDisplayNoise(describeRuntimeFailure(REAL, { modelId: "poe:kimi-k3" })), false);
});
