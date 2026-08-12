/**
 * T2 探针：在「内置预装 + 没有系统 Node」这套条件下，确认 Grok 能把
 * dist/web-search-mcp.js 当子进程拉起来。
 *
 * 这条路径在开发态永远测不到：Extension Host 跑在有 Node、扩展在可写目录、
 * 路径不带空格的机器上。装机后三个条件同时不成立，所以单独探一次。
 *
 * 用法：node scripts/probe-builtin-mcp.mjs "<便携版目录>"
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const appRoot = process.argv[2];
if (!appRoot) {
  console.error("用法: node scripts/probe-builtin-mcp.mjs \"<便携版目录>\"");
  process.exit(2);
}

const exe = findHostExe(appRoot);
const script = findMcpScript(appRoot);

for (const [label, file] of [["宿主可执行文件", exe], ["MCP 脚本", script]]) {
  if (!file || !existsSync(file)) {
    console.error(`找不到${label}${file ? `: ${file}` : ""}`);
    process.exit(2);
  }
}

/** 基座可能是 VS Code、VSCodium，也可能是我们改过名的产物。 */
function findHostExe(root) {
  for (const name of ["Lingdong.exe", "VSCodium.exe", "Code.exe"]) {
    const candidate = path.join(root, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 内置扩展的位置不固定：VSCodium / 源码构建是 `resources/app/extensions`，
 * 而 1.131 之后的官方 Windows 包多套了一层 commit 目录用于后台更新。两种都认。
 */
function findMcpScript(root) {
  const tail = path.join("resources", "app", "extensions", "lingdong-agent", "dist", "web-search-mcp.js");
  const flat = path.join(root, tail);
  if (existsSync(flat)) return flat;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(root, entry.name, tail);
    if (existsSync(nested)) return nested;
  }
  return undefined;
}

console.log(`宿主: ${exe}`);
console.log(`脚本: ${script}`);
console.log(`路径含空格: ${script.includes(" ")}`);

// 刻意不走 PATH 上的 node：装机后的机器上没有，只能靠 Electron 的 node 模式。
const child = spawn(exe, [script], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let buffer = "";
const seen = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      if (message.id != null) seen.set(message.id, message);
    } catch {
      console.log(`[非 JSON 输出] ${line}`);
    }
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(`[子进程 stderr] ${chunk}`));
child.on("error", (error) => {
  console.error(`拉起失败: ${error.message}`);
  process.exit(1);
});

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lingdong-probe", version: "0" } },
});
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

setTimeout(() => {
  child.kill();
  const init = seen.get(1);
  const tools = seen.get(2);
  if (!init) {
    console.error("失败：没有收到 initialize 响应");
    process.exit(1);
  }
  console.log(`initialize 成功，协议版本 ${init.result?.protocolVersion}`);
  const names = (tools?.result?.tools ?? []).map((tool) => tool.name);
  console.log(`tools/list 返回 ${names.length} 个工具: ${names.join(", ")}`);
  process.exit(names.length > 0 ? 0 : 1);
}, 8000);
