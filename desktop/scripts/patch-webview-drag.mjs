/**
 * 把「拖放默认交给 webview」的补丁打进已构建的 workbench 包。
 *
 * 源码补丁在 desktop/vscode/src/vs/workbench/contrib/webview/browser/webviewWindowDragMonitor.ts：
 * 上游 VS Code 在拖拽（含从资源管理器拖文件）时默认蒙住 webview（pointer-events: none），
 * 让编辑器接管 drop 去打开文件；按住 Shift 才把事件让给 webview。
 * Agent 场景正相反：拖进对话面板的文件/图片应该进对话，Shift 才走「编辑器打开」。
 *
 * 全量重建会从源码自然带上补丁；本脚本用于给**已经打好的产物**就地翻转那两个分支，
 * 幂等：已翻转过（或产物来自打过补丁的源码）时会检测到目标形态并直接跳过。
 *
 * 用法：node desktop/scripts/patch-webview-drag.mjs <resources/app 目录>
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const appDir = process.argv[2];
if (!appDir || !existsSync(appDir)) {
  console.error("用法：node patch-webview-drag.mjs <resources/app 目录>");
  process.exit(1);
}

const bundlePath = path.join(appDir, "out", "vs", "workbench", "workbench.desktop.main.js");
const productPath = path.join(appDir, "product.json");
const source = readFileSync(bundlePath, "utf8");

// 只在拖放监视器这个类的窗口内动手，别处出现相似代码一概不碰。
const anchor = source.indexOf("?.windowDidDragStart()");
if (anchor < 0) {
  console.error("找不到 WebviewWindowDragMonitor，产物结构可能已变化，放弃。");
  process.exit(1);
}
const windowStart = Math.max(0, anchor - 400);
const windowEnd = anchor + 1_600;
const region = source.slice(windowStart, windowEnd);

const upstream = "if (event.shiftKey) {\n        onDragEnd();\n      } else {\n        onDragStart();\n      }";
const patched = "if (event.shiftKey) {\n        onDragStart();\n      } else {\n        onDragEnd();\n      }";

const already = region.split(patched).length - 1;
if (already >= 2) {
  console.log("产物已是补丁形态（Shift 才交给编辑器），无需处理。");
  process.exit(0);
}
const hits = region.split(upstream).length - 1;
if (hits !== 2) {
  console.error(`预期在类窗口内命中 2 处上游分支，实际 ${hits} 处，放弃（不做模糊替换）。`);
  process.exit(1);
}

copyFileSync(bundlePath, `${bundlePath}.bak`);
const next = source.slice(0, windowStart) + region.split(upstream).join(patched) + source.slice(windowEnd);
writeFileSync(bundlePath, next);

// product.json 记录了该文件的校验和，不同步更新会弹「安装似乎损坏」。
const product = JSON.parse(readFileSync(productPath, "utf8"));
if (product.checksums?.["vs/workbench/workbench.desktop.main.js"]) {
  const digest = createHash("sha256").update(readFileSync(bundlePath)).digest("base64").replace(/=+$/, "");
  product.checksums["vs/workbench/workbench.desktop.main.js"] = digest;
  writeFileSync(productPath, JSON.stringify(product, null, "\t") + "\n");
  console.log("已更新 product.json 校验和。");
}

console.log("已翻转 DRAG / DRAG_OVER 两处分支：默认交给 webview，按住 Shift 才让编辑器打开文件。");
console.log(`备份：${bundlePath}.bak`);
