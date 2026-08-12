import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { isInsideWorkspace, resolveInsideWorkspace } from "../src/workspace-guard";

const workspace = path.resolve("E:/LingdongCode/workspace/grok-test");

test("工作区内的相对路径与绝对路径都被接受", () => {
  assert.equal(isInsideWorkspace(workspace, "index.html"), true);
  assert.equal(isInsideWorkspace(workspace, path.join(workspace, "assets", "style.css")), true);
  assert.equal(isInsideWorkspace(workspace, "."), true);
});

test("路径穿越与工作区外目标被拒绝", () => {
  assert.equal(isInsideWorkspace(workspace, "../secret.txt"), false);
  assert.equal(isInsideWorkspace(workspace, path.resolve("E:/LingdongCode/grok/data")), false);
  assert.equal(resolveInsideWorkspace(workspace, "..\\..\\.ssh\\id_rsa"), undefined);
});

test("通过校验时返回规范化的绝对路径", () => {
  assert.equal(
    resolveInsideWorkspace(workspace, "./assets/../index.html"),
    path.join(workspace, "index.html"),
  );
});
