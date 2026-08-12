import assert from "node:assert/strict";
import test from "node:test";
import { AgentWorkspaceStore } from "../src/workspace-store";

test("Store 分区变更事件与同源快照", () => {
  const store = new AgentWorkspaceStore();
  const seen: string[][] = [];
  store.on("change", (partitions) => seen.push([...partitions]));

  store.setContextItems([{ id: "ctx-1", type: "file", label: "a.ts", size: 10, truncated: false }]);
  store.setUsage({ usedTokens: 100, source: "exact", updatedAt: 1, contextLimit: 1_000_000 }, "normal");
  store.patchRuntime({ mode: "agent", model: "deepseek-v4-flash" });

  assert.deepEqual(seen[0], ["context"]);
  assert.deepEqual(seen[1], ["usage"]);
  assert.deepEqual(seen[2], ["runtime"]);
  assert.equal(store.snapshot.contextItems[0]?.id, "ctx-1");
  assert.equal(store.snapshot.usage.usedTokens, 100);
  assert.equal(store.snapshot.runtime.mode, "agent");
});

test("布局降级标志写入 Store", () => {
  const store = new AgentWorkspaceStore();
  store.setLayoutFallback(true, "secondarySidebar 不可用");
  assert.equal(store.snapshot.layoutFallback, true);
  assert.match(store.snapshot.layoutFallbackReason ?? "", /secondarySidebar/);
});
