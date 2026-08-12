/**
 * 验收探针：对着**真实产出的安装目录**跑一遍定位逻辑，确认自带的 grok 会被选中。
 *
 * 单测里 bundledRoots 是喂进去的，证明不了打包脚本把 grok 放对了地方。
 * 这里从 appRoot 推路径、用真实文件系统判存在，把「布局」和「定位」对齐这件事验掉。
 *
 * 用法：npx tsx scripts/probe-bundled-grok.mts "<安装目录>"
 */

import { statSync } from "node:fs";
import path from "node:path";
import { bundledGrokRoots, resolveGrokExecutable } from "../src/grok-locator";

const installRoot = process.argv[2];
if (!installRoot) {
  console.error('用法: npx tsx scripts/probe-bundled-grok.mts "<安装目录>"');
  process.exit(2);
}

// 装机后 vscode.env.appRoot 就是这个值。
const appRoot = path.join(installRoot, "resources", "app");
const bundledRoots = bundledGrokRoots(appRoot, "win32");
console.log(`appRoot: ${appRoot}`);
console.log("自带候选目录:");
for (const root of bundledRoots) console.log(`  ${root}`);

const resolution = resolveGrokExecutable("", {
  platform: "win32",
  // 刻意保留真实 PATH：这台机器的 PATH 上就有一份 grok，正好验证自带的能压过它。
  env: process.env,
  bundledRoots,
  exists: (candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  },
});

if (!resolution.ok) {
  console.error(`定位失败: ${resolution.reason}`);
  process.exit(1);
}
console.log(`命中: ${resolution.executable}`);
console.log(`来源: ${resolution.source}`);
process.exit(resolution.source === "bundled" ? 0 : 1);
