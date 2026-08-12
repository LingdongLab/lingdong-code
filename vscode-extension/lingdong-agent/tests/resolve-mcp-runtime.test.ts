import assert from "node:assert/strict";
import test from "node:test";
import { resolveMcpRuntime } from "../src/web-search/resolve-mcp-runtime";

test("PATH 上有 node 时优先用真实 node，不带 ELECTRON_RUN_AS_NODE", () => {
  const runtime = resolveMcpRuntime({
    execPath: "C:\\Apps\\Code.exe",
    whichNode: () => "C:\\nodejs\\node.exe",
  });
  assert.equal(runtime.command, "C:\\nodejs\\node.exe");
  assert.deepEqual(runtime.env, {});
});

test("没有 node 时回退 Code.exe + ELECTRON_RUN_AS_NODE", () => {
  const runtime = resolveMcpRuntime({
    execPath: "C:\\Apps\\Code.exe",
    whichNode: () => undefined,
  });
  assert.equal(runtime.command, "C:\\Apps\\Code.exe");
  assert.equal(runtime.env.ELECTRON_RUN_AS_NODE, "1");
});
