import assert from "node:assert/strict";
import test from "node:test";
import { HunkTrackerClient } from "../src/hunk-tracker.js";

/**
 * 报文形状取自探针实录（.build/probe-caps-*.json）：
 * 扩展方法响应是 { result: {...} } 双层包裹，方法名带 `_x.ai/` 前缀。
 */

function clientWith(handler: (method: string, params: Record<string, unknown>) => unknown): HunkTrackerClient {
  return new HunkTrackerClient(
    {
      request: async <T>(method: string, params: Record<string, unknown> = {}) =>
        handler(method, params) as T,
    },
    { sessionId: () => "s1" },
  );
}

test("get-files 走下划线前缀并剥掉双层 result", async () => {
  const calls: string[] = [];
  const client = clientWith((method) => {
    calls.push(method);
    return {
      result: {
        files: [{
          path: "E:\\repo\\a.txt",
          isAgentFile: true,
          staged: false,
          hunkCount: 2,
          additions: 3,
          deletions: 1,
        }],
      },
    };
  });
  const files = await client.getFiles();
  assert.deepEqual(calls, ["_x.ai/hunk-tracker/get-files"]);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.hunkCount, 2);
  assert.equal(client.hunkCapability, "available");
});

test("方法不存在（-32601）记为 unavailable 并降级，不上抛", async () => {
  let callCount = 0;
  const client = clientWith(() => {
    callCount += 1;
    throw new Error("ACP 错误 -32601: Method not found");
  });
  assert.deepEqual(await client.getFiles(), []);
  assert.equal(client.hunkCapability, "unavailable");
  // 已判定不支持后不再骚扰 Grok。
  assert.equal(await client.getHunks("E:\\repo\\a.txt"), undefined);
  assert.equal(callCount, 1);
  const action = await client.hunkAction("h1", "accept");
  assert.equal(action.success, false);
  assert.equal(callCount, 1);
});

test("业务错误原样上抛，不误判为不支持", async () => {
  const client = clientWith(() => {
    throw new Error("session not found: s1");
  });
  await assert.rejects(() => client.getFiles(), /session not found/);
  assert.equal(client.hunkCapability, "unknown");
});

test("hunk-action 带 sessionId 与参数，返回结构化结果", async () => {
  let seen: Record<string, unknown> | undefined;
  const client = clientWith((method, params) => {
    assert.equal(method, "_x.ai/hunk-tracker/hunk-action");
    seen = params;
    return { result: { success: true, affectedCount: 1 } };
  });
  const result = await client.hunkAction("hunk-1", "reject");
  assert.deepEqual(seen, { sessionId: "s1", hunkId: "hunk-1", action: "reject" });
  assert.deepEqual(result, { success: true, affectedCount: 1 });
});

test("get-hunks 保留基线与当前全文，oldText 为 null 的纯新增照单收下", async () => {
  const client = clientWith(() => ({
    result: {
      hunks: [{
        id: "h1",
        path: "E:\\repo\\a.txt",
        lineInfo: { oldStart: 4, oldCount: 0, newStart: 4, newCount: 1 },
        source: { type: "external" },
        oldText: null,
        newText: "line four added\n",
        patch: "@@ -1,3 +1,4 @@\n line one\n+line four added\n",
        createdAt: "2026-08-10T18:55:19Z",
      }],
      baselineContent: "line one\n",
      currentContent: "line one\nline four added\n",
    },
  }));
  const payload = await client.getHunks("E:\\repo\\a.txt");
  assert.ok(payload);
  assert.equal(payload.hunks.length, 1);
  assert.equal(payload.hunks[0]?.oldText, null);
  assert.equal(payload.baselineContent, "line one\n");
});

test("没有会话时直接抛错，不发无主请求", async () => {
  const client = new HunkTrackerClient(
    { request: async <T,>() => ({ result: {} }) as T },
    { sessionId: () => undefined },
  );
  await assert.rejects(() => client.getFiles(), /没有活动会话/);
});
