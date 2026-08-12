/**
 * 把「webview 编辑器上不压拖放覆盖层」的补丁打进已构建的 workbench 包。
 *
 * 源码补丁在 desktop/vscode/src/vs/workbench/browser/parts/editor/editorDropTarget.ts：
 * 上游在文件拖到编辑器组上时会创建覆盖层（"按住 Shift 以放入编辑器"那个提示），
 * 覆盖层 z-index 10000 压在 webview 之上，之后所有 dragover/drop 都被它吃掉——
 * 对话面板（webview）的拖放入口就永远轮不到。
 * 补丁：目标组的活动编辑器是 webview 且没按 Shift 时，不创建覆盖层、已创建的立即销毁；
 * 按住 Shift 保持上游行为（覆盖层出现、松手编辑器打开文件）。
 *
 * 全量重建会从源码自然带上补丁；本脚本用于给**已经打好的产物**就地加上同样的两个守卫。
 * 幂等：检测到守卫已存在时直接跳过。
 *
 * 用法：node desktop/scripts/patch-editor-drop-overlay.mjs <resources/app 目录>
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const appDir = process.argv[2];
if (!appDir || !existsSync(appDir)) {
  console.error("用法：node patch-editor-drop-overlay.mjs <resources/app 目录>");
  process.exit(1);
}

const bundlePath = path.join(appDir, "out", "vs", "workbench", "workbench.desktop.main.js");
const productPath = path.join(appDir, "product.json");
let source = readFileSync(bundlePath, "utf8");

const WEBVIEW_TYPE_ID = '"workbench.editors.webviewInput"';
const GUARD_MARK = `.typeId === ${WEBVIEW_TYPE_ID}`;

if (source.includes(GUARD_MARK)) {
  // typeId 字符串本身在 webviewPanel contrib 里出现一次；守卫会新增引用。
  const refs = source.split(GUARD_MARK).length - 1;
  if (refs >= 2) {
    console.log("产物已含 webview 拖放守卫，无需处理。");
    process.exit(0);
  }
}

// 只在 DropOverlay / EditorDropTarget 所在模块的窗口内动手。
const anchor = source.indexOf("monaco-workbench-editor-drop-overlay");
if (anchor < 0) {
  console.error("找不到 DropOverlay，产物结构可能已变化，放弃。");
  process.exit(1);
}
const windowStart = Math.max(0, anchor - 3_000);
const windowEnd = Math.min(source.length, anchor + 40_000);
let region = source.slice(windowStart, windowEnd);

// 守卫 1：DropOverlay.onDragOver 开头——非 Shift 且组内活动编辑器是 webview 时自毁。
// groupView 的混淆名从 `this.X.element.classList.add("dragged-over")` 反推。
const groupProp = /this\.(\w+)\.element\.classList\.add\("dragged-over"\)/.exec(region);
const dragOver = /onDragOver: \((\w+)\) => \{\n(\s*)if \(this\.(\w+) && isDragIntoEditorEvent\(\1\)\) \{/.exec(region);
if (!groupProp || !dragOver) {
  console.error("锚点失效：找不到 DropOverlay 的 onDragOver 或 groupView 属性，放弃。");
  process.exit(1);
}
const [dragOverFull, eParam, indent] = dragOver;
const guard1 =
  `onDragOver: (${eParam}) => {\n` +
  `${indent}if (!isDragIntoEditorEvent(${eParam}) && this.${groupProp[1]}.activeEditor?.typeId === ${WEBVIEW_TYPE_ID}) {\n` +
  `${indent}  this.dispose();\n` +
  `${indent}  return;\n` +
  `${indent}}\n` +
  `${indent}if (this.${dragOver[3]} && isDragIntoEditorEvent(${eParam})) {`;
region = region.replace(dragOverFull, guard1);

// 守卫 2：EditorDropTarget.onDragEnter 里创建覆盖层的条件——同样情形下不创建。
const create = /if \((\w+)\) \{\n(\s*)(this\.\w+ = this\.\w+\.createInstance\(DropOverlay, \1\);)/.exec(region);
if (!create) {
  console.error("锚点失效：找不到 DropOverlay 的创建点，放弃。");
  process.exit(1);
}
const [createFull, groupVar, indent2, createStmt] = create;
const guard2 =
  `if (${groupVar} && !(!isDragIntoEditorEvent(event) && ${groupVar}.activeEditor?.typeId === ${WEBVIEW_TYPE_ID})) {\n` +
  `${indent2}${createStmt}`;
region = region.replace(createFull, guard2);

// 创建点所在方法的事件形参必须叫 event（esbuild 保留了源码名），变了就说明上游改动，重新核对。
const enterHead = /\n  (\w+)\(event\) \{\n    if \(isDropIntoEditorEnabledGlobally\(this\.\w+\) && isDragIntoEditorEvent\(event\)\) \{/.exec(region);
if (!enterHead) {
  console.error("锚点失效：onDragEnter 形参不再是 event，守卫 2 引用会悬空，放弃。");
  process.exit(1);
}

copyFileSync(bundlePath, `${bundlePath}.drop-overlay.bak`);
source = source.slice(0, windowStart) + region + source.slice(windowEnd);
writeFileSync(bundlePath, source);

// product.json 记录了该文件的校验和，不同步更新会弹「安装似乎损坏」。
const product = JSON.parse(readFileSync(productPath, "utf8"));
if (product.checksums?.["vs/workbench/workbench.desktop.main.js"]) {
  const digest = createHash("sha256").update(readFileSync(bundlePath)).digest("base64").replace(/=+$/, "");
  product.checksums["vs/workbench/workbench.desktop.main.js"] = digest;
  writeFileSync(productPath, JSON.stringify(product, null, "\t") + "\n");
  console.log("已更新 product.json 校验和。");
}

console.log("已加上两处守卫：webview 编辑器上非 Shift 拖拽不再出现编辑器拖放覆盖层。");
console.log(`备份：${bundlePath}.drop-overlay.bak`);
