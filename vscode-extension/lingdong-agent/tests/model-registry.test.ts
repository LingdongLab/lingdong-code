import assert from "node:assert/strict";
import test from "node:test";
import { ModelRegistry, formatContextWindow } from "../src/model-registry";

test("只注册真实可用模型，不出现 Claude/GPT", () => {
  const registry = new ModelRegistry();
  const ids = registry.list().map((model) => model.id);
  assert.deepEqual(ids, ["deepseek-v4-flash"]);
  assert.equal(registry.get("deepseek-v4-flash")?.contextWindow, 1_000_000);
  assert.equal(registry.get("deepseek-v4-flash")?.supportsTools, true);
  assert.equal(registry.get("claude-opus"), undefined);
  assert.equal(registry.canAutoSelect(), false);
  assert.equal(registry.hasVisionModel(), false);
});

test("本地搜索按 id/显示名过滤", () => {
  const registry = new ModelRegistry();
  assert.equal(registry.search("flash").length, 1);
  assert.equal(registry.search("gpt").length, 0);
});

test("上下文窗口格式化", () => {
  assert.equal(formatContextWindow(1_000_000), "1M");
  assert.equal(formatContextWindow(178_000), "178K");
});
