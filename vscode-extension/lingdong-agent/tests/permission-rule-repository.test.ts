import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createNodeFileSystem } from "../src/file-system-port";
import { JsonStore } from "../src/storage/json-store";
import { PermissionRuleRepository } from "../src/storage/permission-rule-repository";

const workspace = "E:\\LingdongCode\\workspace\\grok-test";

async function setup(): Promise<{ file: string; store: JsonStore }> {
  const directory = await mkdtemp(path.join(tmpdir(), "lingdong-perm-"));
  return { file: path.join(directory, "rules.json"), store: new JsonStore(createNodeFileSystem()) };
}

/** add() 是同步的，落盘是后台的；等一拍再新建仓库读回。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

test("规则落盘后能被新实例读回", async () => {
  const { file, store } = await setup();
  const first = new PermissionRuleRepository(file, store);
  await first.load();
  first.add({ kind: "workspace-write", value: workspace, label: "以后都允许在当前工作区内修改文件", scope: "always" });
  await settle();

  const second = new PermissionRuleRepository(file, store);
  await second.load();
  assert.equal(second.size, 1);
  assert.equal(second.list()[0]?.kind, "workspace-write");
  assert.equal(second.list()[0]?.scope, "always");
});

test("同一范围重复加入只记一条", async () => {
  const { file, store } = await setup();
  const repository = new PermissionRuleRepository(file, store);
  await repository.load();
  repository.add({ kind: "command-prefix", value: "npm test", label: "以后都允许执行 npm test", scope: "always" });
  repository.add({ kind: "command-prefix", value: "npm test", label: "以后都允许执行 npm test", scope: "always" });
  assert.equal(repository.size, 1);
});

test("clear 之后磁盘上也不再有规则", async () => {
  const { file, store } = await setup();
  const repository = new PermissionRuleRepository(file, store);
  await repository.load();
  repository.add({ kind: "read-path", value: workspace, label: "以后都允许读取", scope: "always" });
  await settle();
  await repository.clear();

  const reopened = new PermissionRuleRepository(file, store);
  await reopened.load();
  assert.equal(reopened.size, 0);
});

test("结构不合法的条目被丢弃而不是整份作废", async () => {
  const { file, store } = await setup();
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 3,
      kind: "permissions",
      updatedAt: Date.now(),
      data: [
        { kind: "workspace-write", value: workspace, label: "有效" },
        { kind: "run-anything", value: "*", label: "伪造的范围" },
        { kind: "command-prefix", value: "", label: "空范围" },
      ],
    }),
    "utf8",
  );

  const repository = new PermissionRuleRepository(file, store);
  await repository.load();
  assert.equal(repository.size, 1);
  assert.equal(repository.list()[0]?.value, workspace);
});
