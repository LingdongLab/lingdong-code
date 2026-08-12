import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

const root = path.resolve(__dirname, "..");
const script = path.join(root, "dist", "web-search-mcp.js");

async function roundTrip(payload: string, expectFraming: "ndjson" | "content-length"): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
    let out = Buffer.alloc(0);
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout; stderr=${err}; out=${out.toString("utf8").slice(0, 200)}`));
    }, 5000);
    child.stdout.on("data", (chunk: Buffer) => {
      out = Buffer.concat([out, chunk]);
      const text = out.toString("utf8");
      if (expectFraming === "ndjson") {
        if (text.includes("\n")) {
          clearTimeout(timer);
          child.kill();
          resolve(text);
        }
      } else if (/Content-Length:\s*\d+/i.test(text) && text.includes("{")) {
        // 等 body 到齐：粗判有 result/error
        if (text.includes('"result"') || text.includes('"error"')) {
          clearTimeout(timer);
          child.kill();
          resolve(text);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.write(payload);
    // 不立刻 end：保持进程活着直到我们读完响应
  });
}

test("Grok 风格 NDJSON initialize 能立刻收到响应", async () => {
  const req = `${JSON.stringify({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  })}\n`;
  const text = await roundTrip(req, "ndjson");
  assert.equal(text.includes("Content-Length"), false);
  const line = text.trim().split("\n")[0] ?? "";
  const msg = JSON.parse(line) as { id: number; result: { protocolVersion: string; serverInfo: { name: string } } };
  assert.equal(msg.id, 0);
  assert.equal(msg.result.protocolVersion, "2025-06-18");
  assert.equal(msg.result.serverInfo.name, "lingdong-web");
});

test("Content-Length initialize 仍可用", async () => {
  const body = Buffer.from(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  }), "utf8");
  const payload = `Content-Length: ${body.length}\r\n\r\n${body.toString("utf8")}`;
  const text = await roundTrip(payload, "content-length");
  assert.match(text, /Content-Length:\s*\d+/i);
  assert.match(text, /"id":1/);
  assert.match(text, /lingdong-web/);
});
