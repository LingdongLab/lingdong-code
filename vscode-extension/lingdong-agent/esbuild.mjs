import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

// webview 的 localResourceRoots 只开了 dist，media/ 在授权范围外。
// 品牌标记要在面板里显示，就得进 dist —— 而不是反过来把资源根放宽。
mkdirSync("dist/webview", { recursive: true });
copyFileSync("media/mark.png", "dist/webview/mark.png");
const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  legalComments: "none",
};

const extension = await esbuild.context({
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vscode"],
});

// 宿主侧联网搜索 MCP：由 Grok 按 config.toml 以 stdio 子进程拉起。
const webSearchMcp = await esbuild.context({
  ...shared,
  entryPoints: ["src/web-search/web-search-mcp.ts"],
  outfile: "dist/web-search-mcp.js",
  platform: "node",
  target: "node20",
  format: "cjs",
});

// 校验闭环钩子：由 Grok 按 hooks JSON 在 Stop 等事件上拉起，跑在扩展进程之外。
const verifyGate = await esbuild.context({
  ...shared,
  entryPoints: ["src/verify-gate/verify-gate.ts"],
  outfile: "dist/verify-gate.js",
  platform: "node",
  target: "node20",
  format: "cjs",
});

const webview = await esbuild.context({
  ...shared,
  entryPoints: [
    "src/webview/main.ts",
    "src/webview/launcher.ts",
    "src/webview/side-plan-panel.ts",
    "src/webview/side-tasks-panel.ts",
    "src/webview/side-changes-panel.ts",
    "src/webview/side-context-panel.ts",
    // 统一设置页：独立面板与独立协议，单独出一个 bundle，
    // 产物落 dist/webview/settings/main.{js,css}。
    "src/webview/settings/main.ts",
  ],
  outdir: "dist/webview",
  platform: "browser",
  target: "es2022",
  format: "iife",
});

if (watch) {
  await Promise.all([extension.watch(), webSearchMcp.watch(), verifyGate.watch(), webview.watch()]);
} else {
  await Promise.all([extension.rebuild(), webSearchMcp.rebuild(), verifyGate.rebuild(), webview.rebuild()]);
  await Promise.all([extension.dispose(), webSearchMcp.dispose(), verifyGate.dispose(), webview.dispose()]);
}
