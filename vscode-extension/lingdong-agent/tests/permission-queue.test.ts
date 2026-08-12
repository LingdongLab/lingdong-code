import assert from "node:assert/strict";
import test from "node:test";
import { PermissionQueue } from "../src/permission-queue";

test("一次只暴露一个当前卡片，其余排队", () => {
  const queue = new PermissionQueue<string>();
  assert.equal(queue.enqueue("0", "编辑 index.html"), true);
  assert.equal(queue.enqueue("1", "编辑 about.html"), true);
  assert.equal(queue.current?.requestId, "0");
  assert.equal(queue.waiting, 1);

  queue.resolve("0");
  assert.equal(queue.current?.requestId, "1");
  assert.equal(queue.waiting, 0);
});

test("重复与已处理的 requestId 不能再次入队", () => {
  const queue = new PermissionQueue<string>();
  queue.enqueue("0", "a");
  assert.equal(queue.enqueue("0", "a"), false);
  queue.resolve("0");
  assert.equal(queue.isHandled("0"), true);
  assert.equal(queue.enqueue("0", "a"), false);
  assert.equal(queue.enqueue("", "a"), false);
});

test("只有当前卡片可以被处理，伪造 requestId 无效", () => {
  const queue = new PermissionQueue<string>();
  queue.enqueue("0", "a");
  queue.enqueue("1", "b");
  assert.equal(queue.resolve("1"), undefined);
  assert.equal(queue.resolve("999"), undefined);
  assert.equal(queue.current?.requestId, "0");
  assert.ok(queue.resolve("0"));
});

test("超时失效可以移除队列中任意位置的卡片", () => {
  const queue = new PermissionQueue<string>();
  queue.enqueue("0", "a");
  queue.enqueue("1", "b");
  const expired = queue.expire("1");
  assert.equal(expired?.requestId, "1");
  assert.equal(queue.isHandled("1"), true);
  assert.equal(queue.size, 1);
  assert.equal(queue.current?.requestId, "0");
});

test("clear 会返回全部被丢弃的卡片并标记为已处理", () => {
  const queue = new PermissionQueue<string>();
  queue.enqueue("0", "a");
  queue.enqueue("1", "b");
  const dropped = queue.clear();
  assert.deepEqual(dropped.map((entry) => entry.requestId), ["0", "1"]);
  assert.equal(queue.current, undefined);
  assert.equal(queue.isHandled("0"), true);
  assert.equal(queue.enqueue("1", "b"), false);
});
