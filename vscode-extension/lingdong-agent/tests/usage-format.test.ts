import assert from "node:assert/strict";
import test from "node:test";
import {
  composerStatusLine,
  formatUsageLabel,
  formatUsagePercentLine,
  formatUsageTokensLine,
} from "../src/usage-format";

test("用量文案：Cursor 式百分比 + tokens", () => {
  assert.equal(
    formatUsagePercentLine({ usedTokens: 178_000, contextLimit: 1_000_000, percentage: 17.8, source: "exact", updatedAt: 1 }),
    "18% context used",
  );
  assert.equal(
    formatUsageTokensLine({ usedTokens: 30_300, contextLimit: 256_000, percentage: 11.8, source: "exact", updatedAt: 1 }),
    "30.3K / 256K tokens",
  );
  assert.match(
    formatUsageLabel({ usedTokens: 178_000, contextLimit: 1_000_000, percentage: 17.8, source: "exact", updatedAt: 1 }),
    /context used/,
  );
  assert.equal(
    formatUsagePercentLine({ usedTokens: 0, source: "unavailable", updatedAt: 1 }),
    "",
  );
});

test("底栏状态行：不可用时不带用量尾巴", () => {
  const withUsage = composerStatusLine({
    mode: "agent",
    model: "deepseek-v4-flash",
    usage: { usedTokens: 1000, contextLimit: 1_000_000, percentage: 0.1, source: "exact", updatedAt: 1 },
  });
  assert.match(withUsage, /^agent · deepseek-v4-flash · 0% context used$/);

  const bare = composerStatusLine({
    mode: "ask",
    model: "deepseek-v4-flash",
    usage: { usedTokens: 0, source: "unavailable", updatedAt: 1 },
  });
  assert.equal(bare, "ask · deepseek-v4-flash");
});
