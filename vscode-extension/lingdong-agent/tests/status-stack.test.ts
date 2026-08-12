import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { StatusStack } from "../src/webview/status-stack";

/**
 * Composer 上方三条状态互斥。
 * 以前 turn-status、排队 chips、任务进度条各管各的 hidden，忙起来会一起冒出来，
 * 把输入框往下顶掉三行；现在只准最高优先级的那一条露面。
 */

function installDom(): Document {
  const dom = new JSDOM("<!DOCTYPE html><div id=\"root\"></div>");
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  return dom.window.document;
}

interface Bars {
  stack: StatusStack;
  turn: HTMLElement;
  queue: HTMLElement;
  task: HTMLElement;
}

function createBars(): Bars {
  const document = installDom();
  const stack = new StatusStack();
  const turn = document.createElement("div");
  const queue = document.createElement("div");
  const task = document.createElement("div");
  stack.register("turn", turn);
  stack.register("queue", queue);
  stack.register("task", task);
  return { stack, turn, queue, task };
}

test("三条都想显示时只留 turn-status", () => {
  const bars = createBars();
  bars.stack.want("task", true);
  bars.stack.want("queue", true);
  bars.stack.want("turn", true);
  assert.equal(bars.stack.visible, "turn");
  assert.deepEqual(
    [bars.turn.hidden, bars.queue.hidden, bars.task.hidden],
    [false, true, true],
  );
});

test("turn 收起后队列顶上，队列清空再轮到任务进度", () => {
  const bars = createBars();
  bars.stack.want("task", true);
  bars.stack.want("queue", true);
  bars.stack.want("turn", true);

  bars.stack.want("turn", false);
  assert.equal(bars.stack.visible, "queue");
  assert.equal(bars.queue.hidden, false);
  assert.equal(bars.task.hidden, true);

  bars.stack.want("queue", false);
  assert.equal(bars.stack.visible, "task");
  assert.equal(bars.task.hidden, false);
});

test("谁都不想显示时三条全隐藏", () => {
  const bars = createBars();
  bars.stack.want("turn", false);
  bars.stack.want("queue", false);
  bars.stack.want("task", false);
  assert.equal(bars.stack.visible, undefined);
  assert.deepEqual([bars.turn.hidden, bars.queue.hidden, bars.task.hidden], [true, true, true]);
});

test("没登记的槽位不参与排序，精简 DOM 里也不会误隐藏别人", () => {
  const document = installDom();
  const stack = new StatusStack();
  const queue = document.createElement("div");
  stack.register("queue", queue);
  stack.register("turn", undefined);

  stack.want("turn", true);
  stack.want("queue", true);
  assert.equal(stack.visible, "queue");
  assert.equal(queue.hidden, false);
});
