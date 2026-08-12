import assert from "node:assert/strict";
import test from "node:test";
import { JsonLineDecoder } from "../src/protocol.js";

test("一次读取可拆出多条 JSON-RPC 消息", () => {
  const decoder = new JsonLineDecoder();
  const result = decoder.push('{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","method":"tick"}\n');
  assert.equal(result.messages.length, 2);
  assert.equal(result.errors.length, 0);
});

test("半包消息会缓存到下一次读取", () => {
  const decoder = new JsonLineDecoder();
  assert.equal(decoder.push('{"jsonrpc":"2.0","id":1').messages.length, 0);
  const result = decoder.push(',"result":{"ok":true}}\n');
  assert.equal(result.messages.length, 1);
  assert.equal(result.errors.length, 0);
});

test("非法 JSON 被隔离且后续帧仍可解析", () => {
  const decoder = new JsonLineDecoder();
  const result = decoder.push('not-json\n{"jsonrpc":"2.0","id":2,"result":null}\n');
  assert.equal(result.errors.length, 1);
  assert.equal(result.messages.length, 1);
});
