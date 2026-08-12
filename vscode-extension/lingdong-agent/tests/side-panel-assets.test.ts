import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { SIDE_KINDS, sidePanelAssets } from "../src/side-panels";

const root = path.resolve(__dirname, "..");

test("侧栏样式与脚本来自同一个 esbuild entry", () => {
  for (const kind of SIDE_KINDS) {
    const assets = sidePanelAssets(kind);
    assert.equal(assets.script, `side-${kind}-panel.js`);
    // 链 main.css 会让入口自己 import 的样式整段失效，这条断言就是为了不再回到那里。
    assert.equal(assets.style, `side-${kind}-panel.css`);
    assert.notEqual(assets.style, "main.css");
  }
});

test("每个侧栏入口都真实存在，esbuild 才会产出对应的 CSS", async () => {
  const config = await readFile(path.join(root, "esbuild.mjs"), "utf8");
  for (const kind of SIDE_KINDS) {
    assert.ok(
      config.includes(`src/webview/side-${kind}-panel.ts`),
      `esbuild 缺少 side-${kind}-panel 入口，样式名会指向不存在的文件`,
    );
  }
});
