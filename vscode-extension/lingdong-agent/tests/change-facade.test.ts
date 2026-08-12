import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { HostToWebviewMessage } from "../src/messages";
import { ChangeFacade } from "../src/services/change-facade";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lingdong-change-"));
}

function createFacade() {
  const posted: HostToWebviewMessage[] = [];
  const stored: unknown[] = [];
  const snapshotRoot = tempDir();
  const facade = new ChangeFacade({
    post: (message) => posted.push(message),
    log: () => undefined,
    postState: () => undefined,
    ui: {} as never,
    store: { setChanges: (view: unknown) => stored.push(view) } as never,
    fs: {} as never,
    persistence: () => undefined,
    flushPersistence: () => undefined,
    snapshotRoot: () => snapshotRoot,
  });
  facade.setup("E:\\Code\\Repo");
  facade.startTurn({ sessionId: "s-1", mode: "agent", prompt: "你是谁", contextLabels: [] });
  const cleanup = (): void => fs.rmSync(snapshotRoot, { recursive: true, force: true });
  return { facade, posted, stored, cleanup };
}

test("零改动的轮次不推变更列表：面板会因此多出一张「0 个文件已修改」的空卡", () => {
  const { facade, posted, stored, cleanup } = createFacade();
  try {
    const turnId = facade.currentTurnId;
    assert.ok(turnId, "startTurn 之后应有当前轮次");
    assert.equal(facade.turn(turnId)?.changedFiles.length, 0, "纯问答那一轮没碰过文件");

    assert.equal(facade.postChanges(turnId), false);
    assert.equal(posted.filter((message) => message.type === "changes").length, 0);
    assert.equal(stored.length, 0, "空列表也不该写进 store");
  } finally {
    cleanup();
  }
});

test("查看变更命令在最近一轮没碰文件时明确说一句，不是静默无反应", async () => {
  const { facade, posted, cleanup } = createFacade();
  try {
    facade.lastTurnId = facade.currentTurnId;
    await facade.reveal();
    const notices = posted.filter((message) => message.type === "notice");
    assert.equal(notices.length, 1);
    assert.match(
      notices[0]?.type === "notice" ? notices[0].message : "",
      /还没有产生文件修改/,
    );
  } finally {
    cleanup();
  }
});
