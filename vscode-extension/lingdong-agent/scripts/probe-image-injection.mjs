// 注入之后，图片到底有没有出现在真正发往上游的请求体里？
//
// 这是图片通道唯一可信的验收方式。probe-image-forward.mjs 已经证明：Grok 收下
// image content block 之后会静默丢掉，所以「没报错」什么都说明不了，必须看字节。
//
// 链路是完整的真链路，只把最上游换成本机假服务：
//
//   Grok（真二进制） → ModelProxy（我们的转发层，做注入） → 本机假上游（抓包）
//
// 不连外网、不花额度、不需要 API Key，结论仍然是硬证据。
//
// 用法：npx tsx scripts/probe-image-injection.mjs [responses|chat_completions]
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import path from "node:path";
import { ModelProxy } from "../src/models/providers/model-proxy.ts";
import { ImageStore, imageMarker } from "../src/services/image-store.ts";

const executable = process.env.LINGDONG_GROK ?? "E:\\LingdongCode\\grok\\bin\\grok.exe";
const workspace = process.env.LINGDONG_WORKSPACE ?? "E:\\LingdongCode\\workspace\\grok-test";
const backend = process.argv[2] === "chat_completions" ? "chat_completions" : "responses";
const MODEL_ID = "probe-model";

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/** 纯色 PNG，用代码生成而不是塞死一串 base64。 */
function solidPng(size, [r, g, b]) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    for (let x = 0; x < size; x++) {
      const at = row + 1 + x * 3;
      raw[at] = r; raw[at + 1] = g; raw[at + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const png = solidPng(8, [220, 20, 60]);
const pngBase64 = png.toString("base64");

// 假上游：把 Grok 经由转发层发出来的请求体整个留下。
const captured = [];
const upstream = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    captured.push({ path: req.url, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = upstream.address().port;

// 上下文层会做的事：图片进暂存，提示词里只留一个标记。
const images = new ImageStore();
const added = images.add("red.png", `data:image/png;base64,${pngBase64}`);
if (!added.ok) throw new Error(`图片没进暂存：${added.message}`);
const marker = imageMarker(added.image.id);

const proxy = new ModelProxy({ images: () => images, log: (line) => console.log(line) });
await proxy.start();
const localBaseUrl = proxy.register(`http://127.0.0.1:${upstreamPort}`);
console.log(`假上游 127.0.0.1:${upstreamPort} ← 转发层 ${localBaseUrl} | api_backend=${backend}`);

const home = await mkdtemp(path.join(tmpdir(), "lingdong-fakehome-"));
await writeFile(
  path.join(home, "config.toml"),
  [
    "[models]",
    `default = "${MODEL_ID}"`,
    "",
    "[features]",
    "telemetry = false",
    "feedback = false",
    "remote_fetch = false",
    "",
    "[cli]",
    "auto_update = false",
    "",
    `[model.${MODEL_ID}]`,
    `model = "${MODEL_ID}"`,
    `base_url = "${localBaseUrl}"`,
    'name = "Probe Model"',
    'env_key = "LINGDONG_PROBE_KEY"',
    `api_backend = "${backend}"`,
    "",
  ].join("\n"),
  "utf8",
);

const child = spawn(executable, ["--no-auto-update", "agent", "-m", MODEL_ID, "stdio"], {
  cwd: workspace,
  env: { ...process.env, GROK_HOME: home, LINGDONG_PROBE_KEY: "probe-not-a-real-key" },
  shell: false,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
const pending = new Map();
let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

function request(method, params, timeoutMs = 60_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

try {
  await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "lingdong-probe", title: "探针", version: "0.0.1" },
  });
  const session = await request("session/new", { cwd: workspace, mcpServers: [], _meta: { yoloMode: true } });
  const sessionId = session.result?.sessionId;

  // 注意这里发的是**纯文本**：图片不经过 Grok，只有一个标记跟着走。
  await request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: `PROBE_MARKER 这张图是什么颜色？ ${marker}` }],
  }).catch((error) => console.log("prompt 未正常返回（不影响抓包）：", error.message));
} catch (error) {
  console.error("探针失败：", error instanceof Error ? error.message : error);
} finally {
  child.kill();
  await proxy.stop();
  upstream.close();
}

console.log(`\n抓到 ${captured.length} 个上游请求`);
let verdict = false;
for (const [index, item] of captured.entries()) {
  const hasText = item.body.includes("PROBE_MARKER");
  const hasImage = item.body.includes(pngBase64.slice(0, 40));
  const leaked = item.body.includes("lingdong-image");
  console.log(`\n--- #${index + 1} ${item.path} (${item.body.length} 字节) ---`);
  console.log("含文本         :", hasText);
  console.log("含图片 base64  :", hasImage);
  console.log("标记漏出       :", leaked, leaked ? "← 这是缺陷，标记不该到达模型" : "");
  if (hasImage) verdict = true;
  const spot = item.body.search(/image_url|input_image|data:image/);
  if (spot >= 0) console.log("  片段:", item.body.slice(Math.max(0, spot - 100), spot + 160));
}

console.log(`\n结论：${verdict ? "图片已送达上游请求体" : "图片没有出现在请求体里"}`);
process.exit(verdict ? 0 : 1);
