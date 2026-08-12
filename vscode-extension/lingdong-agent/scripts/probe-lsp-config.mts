/**
 * 端到端核对：我们渲染出的 lsp.json，Grok 自己认不认。
 *
 * 只靠单测保证不了这件事——字段名错一个（比如 extensions 写成数组），serde 会静默
 * 整份丢弃，表现为「配了但一个 language server 都没加载」。这里把渲染结果丢进一个
 * 临时 GROK_HOME，用 `grok inspect --json` 看它报出来的 lspServers。
 *
 * 用法：npm run check:lsp
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { composeLspEntry, findPreset, renderLspJson } from "../src/lsp/lsp-presets";

const execFileAsync = promisify(execFile);

const GROK = process.env.LINGDONG_GROK_EXECUTABLE
  ?? path.resolve("E:/LingdongCode/grok/bin/grok.exe");

const preset = findPreset("typescript");
if (!preset) throw new Error("预置里没有 typescript");

// 用一个一定存在的可执行文件冒充 language server：这里要验的是配置能不能被读进来，
// 不是 server 本身能不能握手。
const fakeServer = process.execPath;
const contents = renderLspJson({ [preset.id]: composeLspEntry(preset, fakeServer) });
if (!contents) throw new Error("渲染结果为空");

const home = await mkdtemp(path.join(tmpdir(), "lingdong-lsp-"));
try {
  await writeFile(path.join(home, "lsp.json"), contents, "utf8");
  await writeFile(path.join(home, "config.toml"), "[features]\nlsp_tools = true\n", "utf8");

  const { stdout } = await execFileAsync(GROK, ["inspect", "--json"], {
    env: { ...process.env, GROK_HOME: home },
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  const report = JSON.parse(stdout) as {
    lspServers?: Array<{ name?: string; source?: unknown }>;
  };
  const names = (report.lspServers ?? []).map((item) => item.name ?? "?");

  console.log("渲染的 lsp.json：");
  console.log(contents.trim());
  console.log(`grok inspect 报告的 lspServers：[${names.join(", ")}]`);
  if (!names.includes(preset.id)) {
    console.error("失败：Grok 没有把我们写的 server 读进来，字段名或结构对不上。");
    process.exit(1);
  }
  console.log("通过：Grok 认这份 lsp.json。");
} finally {
  await rm(home, { recursive: true, force: true });
}
