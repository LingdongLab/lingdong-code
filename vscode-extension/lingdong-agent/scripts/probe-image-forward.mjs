// Grok 收下 image content block 之后，到底有没有把图片转发给模型？
//
// probe-image-block.mjs 已经证明 ACP 层不拒收（尽管 promptCapabilities.image = false），
// 但「收下」和「转发」是两回事——它完全可能默默丢掉图片只发文字。
// 这里不连真服务商：起一个本地假上游，把 Grok 实际发出的请求体整个抓下来，
// 于是既不花额度也不需要任何 API Key，结论还是硬证据。
//
// 用法：node scripts/probe-image-forward.mjs [responses|chat_completions] [上游模型名]
//
// 第二个参数用来试探 Grok 是否按模型名决定要不要带图：传一个它认得的视觉模型
// （如 grok-4.5）与传一个陌生名字，抓到的请求体如果不同，说明它有自己的能力表。
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import path from "node:path";

const executable = process.env.LINGDONG_GROK ?? "E:\\LingdongCode\\grok\\bin\\grok.exe";
const workspace = process.env.LINGDONG_WORKSPACE ?? "E:\\LingdongCode\\workspace\\grok-test";
const backend = process.argv[2] === "chat_completions" ? "chat_completions" : "responses";
const MODEL_ID = "probe-model";
const API_MODEL = process.argv[3] ?? MODEL_ID;

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

const captured = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    captured.push({ path: req.url, body: Buffer.concat(chunks).toString("utf8") });
    // 回一个最简单的 SSE，让 Grok 有东西可读而不是无限重试。
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
console.log(`假上游监听 127.0.0.1:${port} | api_backend=${backend}`);

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
    `model = "${API_MODEL}"`,
    `base_url = "http://127.0.0.1:${port}"`,
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

  await request("session/prompt", {
    sessionId,
    prompt: [
      { type: "text", text: "PROBE_MARKER 这张图是什么颜色？" },
      { type: "image", data: pngBase64, mimeType: "image/png" },
    ],
  }).catch((error) => console.log("prompt 未正常返回（不影响抓包）：", error.message));
} catch (error) {
  console.error("探针失败：", error instanceof Error ? error.message : error);
} finally {
  child.kill();
  server.close();
}

console.log(`\n抓到 ${captured.length} 个上游请求`);
for (const [index, item] of captured.entries()) {
  console.log(`\n--- #${index + 1} ${item.path} (${item.body.length} 字节) ---`);
  const hasMarker = item.body.includes("PROBE_MARKER");
  const hasPngBase64 = item.body.includes(pngBase64.slice(0, 40));
  const hasImageKey = /image_url|input_image|"image"|base64|data:image/.test(item.body);
  console.log("含文本标记 PROBE_MARKER:", hasMarker);
  console.log("含图片 base64 原文     :", hasPngBase64);
  console.log("含 image 相关字段      :", hasImageKey);
  if (hasImageKey && !hasPngBase64) {
    console.log("  提示：出现了 image 字段但不是我们那张图，可能被重新编码，下面看片段。");
  }
  const spot = item.body.search(/image_url|input_image|"image"|data:image/);
  if (spot >= 0) console.log("  片段:", item.body.slice(Math.max(0, spot - 120), spot + 240));
  else console.log("  正文前 400 字:", item.body.slice(0, 400));
}
