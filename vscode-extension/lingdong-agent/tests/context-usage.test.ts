import assert from "node:assert/strict";
import test from "node:test";
import {
  ContextUsageService,
  estimateTokens,
  usageLevel,
} from "../src/context-usage";

test("只有明确 usage 才标记为 exact", () => {
  const service = new ContextUsageService({ contextLimit: 1000, now: () => 1 });
  const usage = service.recordExact({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
  assert.equal(usage.source, "exact");
  assert.equal(usage.usedTokens, 120);
  assert.equal(usage.percentage, 12);
});

test("估算不会伪装成精确 Token", () => {
  const service = new ContextUsageService({ contextLimit: 1000, now: () => 1 });
  const usage = service.recordEstimate({
    systemRules: 10,
    history: 40,
    fileContext: 50,
    toolOutput: 0,
    plan: 0,
    currentTask: 20,
  });
  assert.equal(usage.source, "estimated");
  assert.equal(usage.usedTokens, 120);
  assert.ok(usage.percentage !== undefined);
});

test("无数据时为 unavailable", () => {
  const service = new ContextUsageService({ now: () => 1 });
  assert.equal(service.current.source, "unavailable");
  assert.equal(service.current.usedTokens, 0);
  assert.equal(service.current.percentage, undefined);
});

test("阈值状态按百分比划分", () => {
  assert.equal(usageLevel(0), "normal");
  assert.equal(usageLevel(69.9), "normal");
  assert.equal(usageLevel(70), "warning");
  assert.equal(usageLevel(85), "critical");
  assert.equal(usageLevel(95), "full");
  assert.equal(usageLevel(undefined), "normal");
});

test("contextLimit 缺失时不计算百分比", () => {
  const service = new ContextUsageService({ now: () => 1 });
  const usage = service.recordExact({ totalTokens: 500 });
  assert.equal(usage.percentage, undefined);
  assert.equal(usage.contextLimit, undefined);
});

test("已有 exact 时较小的估算不会覆盖", () => {
  const service = new ContextUsageService({ contextLimit: 10_000, now: () => 1 });
  service.recordExact({ totalTokens: 800 });
  const again = service.recordEstimate({ history: 100 });
  assert.equal(again.source, "exact");
  assert.equal(again.usedTokens, 800);
});

test("压缩能力可标记 available / unavailable", () => {
  const service = new ContextUsageService();
  assert.equal(service.compactionCapability, "unknown");
  service.setCompactionCapability("unavailable");
  assert.equal(service.compactionCapability, "unavailable");
  service.setCompactionCapability("available");
  assert.equal(service.compactionCapability, "available");
});

test("估算器对中文更接近 1 字 1 Token", () => {
  assert.ok(estimateTokens("首页产品介绍") >= 6);
  assert.ok(estimateTokens("abcd") <= 2);
});

test("流式 totalTokens 记为 estimated 并可推高进度", () => {
  const service = new ContextUsageService({ contextLimit: 256_000, now: () => 1 });
  const first = service.recordStream(30_300);
  assert.equal(first.source, "estimated");
  assert.equal(first.usedTokens, 30_300);
  assert.equal(first.percentage, 11.8);

  const same = service.recordStream(30_300);
  assert.equal(same.updatedAt, first.updatedAt);

  const higher = service.recordStream(40_000);
  assert.equal(higher.usedTokens, 40_000);
  assert.equal(higher.source, "estimated");
});

test("流式不会压过更大的 exact", () => {
  const service = new ContextUsageService({ contextLimit: 10_000, now: () => 1 });
  service.recordExact({ totalTokens: 800 });
  const again = service.recordStream(100);
  assert.equal(again.source, "exact");
  assert.equal(again.usedTokens, 800);
});
