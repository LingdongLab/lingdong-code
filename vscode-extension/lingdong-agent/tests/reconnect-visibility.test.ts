import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createAppState, type AppElements } from "../src/webview/app-context";
import { MessageRouter, type RouterDeps } from "../src/webview/message-router";
import type { HostToWebviewMessage } from "../src/messages";

/**
 * 重连按钮什么时候该出现。
 *
 * 用户反馈「一直显示重新连接」的成因：这个按钮原本由 `error.recoverable` 驱动，
 * 而 recoverable 的含义是「这次操作失败了但还能接着用」——打开 Diff 失败、
 * 保存计划失败、权限回执失败全算。任何一次这类失败都会点亮按钮，
 * 而当时唯一能让它熄灭的路径是重新拉起一次 Grok 子进程，
 * 于是连接明明好好的，按钮却一直挂在那里。
 */

interface Harness {
  router: MessageRouter;
  reconnect: HTMLButtonElement;
  apply(message: HostToWebviewMessage): void;
  /** 模拟一轮任务推进到某个主状态。 */
  turn(status: string): void;
}

function harness(): Harness {
  const dom = new JSDOM(`<!DOCTYPE html><button id="reconnect" hidden></button>`);
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  const reconnect = dom.window.document.getElementById("reconnect") as HTMLButtonElement;

  let turnStatusValue = "idle";
  const deps = {
    el: { reconnect } as unknown as AppElements,
    state: createAppState(),
    post: () => undefined,
    conversation: {
      sealStreaming: () => undefined,
      appendRow: () => undefined,
      shouldSuppressNotice: () => false,
    },
    composer: { updateChrome: () => undefined },
    turnStatus: {
      apply: (message: { status: string }) => { turnStatusValue = message.status; },
      get status() { return turnStatusValue; },
    },
  } as unknown as RouterDeps;

  const router = new MessageRouter(deps);
  return {
    router,
    reconnect,
    apply: (message) => router.apply(message),
    turn(status) {
      router.apply({
        type: "turnStatus",
        status: status as never,
        label: "",
        activeElapsedMs: 0,
        showElapsed: false,
        visible: status !== "idle",
        canStop: false,
        connectionActions: status === "interrupted",
      });
    },
  };
}

test("连接断了才显示重连", () => {
  const h = harness();
  assert.equal(h.reconnect.hidden, true);

  h.apply({ type: "connection", state: "failed", detail: "子进程退出" });
  assert.equal(h.reconnect.hidden, false);

  h.apply({ type: "connection", state: "ready", detail: "ACP v1" });
  assert.equal(h.reconnect.hidden, true);
});

test("与连接无关的可恢复错误不该点亮重连按钮", () => {
  const h = harness();

  h.apply({ type: "error", message: "打开 Diff 失败：文件已删除", recoverable: true });

  assert.equal(
    h.reconnect.hidden,
    true,
    "一次打不开 Diff 不代表连接坏了；按它点亮，按钮就会一直挂着",
  );
});

test("一连串可恢复错误也不会让按钮常亮", () => {
  const h = harness();
  for (const message of ["保存计划失败：磁盘只读", "压缩失败：上游拒绝", "权限回执失败：请求已失效"]) {
    h.apply({ type: "error", message, recoverable: true });
  }
  assert.equal(h.reconnect.hidden, true);
});

test("本轮以连接中断收尾时显示重连", () => {
  const h = harness();
  h.turn("interrupted");
  assert.equal(h.reconnect.hidden, false);
});

test("中断之后开始新一轮，按钮自己熄灭，不必等重启子进程", () => {
  const h = harness();
  h.turn("interrupted");
  assert.equal(h.reconnect.hidden, false);

  h.turn("preparing");

  assert.equal(
    h.reconnect.hidden,
    true,
    "新一轮已经跑起来了，说明连接是通的，按钮不该还留在界面上",
  );
});

test("连接仍是断的时候，新一轮不会把按钮藏掉", () => {
  const h = harness();
  h.apply({ type: "connection", state: "failed", detail: "子进程退出" });
  h.turn("preparing");
  assert.equal(h.reconnect.hidden, false);
});
