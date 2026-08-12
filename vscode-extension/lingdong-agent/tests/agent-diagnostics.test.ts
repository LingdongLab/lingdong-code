import assert from "node:assert/strict";
import test from "node:test";
import { renderAgentDiagnostics } from "../src/diagnostics/agent-diagnostics";
import { parseGrokInspect } from "../src/diagnostics/grok-inspect";

/** 取自 grok 0.2.118 `inspect --json` 的真实输出（已裁剪无关字段）。 */
const REAL_INSPECT = JSON.stringify({
  grokVersion: "0.2.118",
  channel: "stable",
  cwd: "E:\\LingdongCode\\workspace\\grok-test",
  projectRoot: null,
  projectTrusted: true,
  projectInstructions: [
    {
      path: "E:\\LingdongCode\\workspace\\grok-test\\Agents.md",
      scope: "project",
      fileType: "agents_md",
      sizeBytes: 143,
      approxTokens: 35,
    },
    {
      path: "E:\\LingdongCode\\workspace\\grok-test\\.grok/rules\\demo.md",
      scope: "project",
      fileType: "rules",
      sizeBytes: 35,
      approxTokens: 8,
    },
  ],
  permissions: { sources: [], loaded: 0, skipped: [] },
  hooks: [],
  skills: [],
  agents: [
    { name: "general-purpose", description: "General purpose agent.", source: { type: "builtin" } },
    { name: "explore", description: "Read-only explorer.", source: { type: "builtin" } },
  ],
  plugins: [],
  marketplaces: [],
  mcpServers: [],
  lspServers: [],
  configSources: { layers: [{ role: "user", path: "E:\\LingdongCode\\grok\\data\\config.toml" }] },
  externalCompat: {
    cells: [
      { vendor: "cursor", surface: "rules", enabled: true, source: "default" },
      { vendor: "cursor", surface: "skills", enabled: true, source: "default" },
      { vendor: "claude", surface: "rules", enabled: false, source: "default" },
    ],
  },
});

test("解析真实 inspect 输出：规则文件带上 token 数", () => {
  const report = parseGrokInspect(REAL_INSPECT);
  assert.equal(report.grokVersion, "0.2.118");
  assert.equal(report.projectTrusted, true);
  assert.equal(report.projectInstructions.length, 2);
  assert.equal(report.projectInstructions[0]?.fileType, "agents_md");
  assert.equal(report.projectInstructions[0]?.approxTokens, 35);
  assert.equal(report.agents.length, 2);
  assert.equal(report.agents[0]?.source, "builtin");
  assert.equal(report.configLayers[0]?.role, "user");
});

test("只保留启用的 harness 兼容项，关掉的不进报告", () => {
  const report = parseGrokInspect(REAL_INSPECT);
  assert.equal(report.externalCompat.length, 2);
  assert.ok(report.externalCompat.every((cell) => cell.vendor === "cursor"));
});

test("上游加字段或字段缺失都不该让诊断整体失败", () => {
  const report = parseGrokInspect(JSON.stringify({ grokVersion: "9.9.9", futureField: { a: 1 } }));
  assert.equal(report.grokVersion, "9.9.9");
  assert.deepEqual(report.projectInstructions, []);
  assert.equal(report.permissionsLoaded, 0);
  assert.deepEqual(report.agents, []);
});

test("非 JSON 输出给出明确错误，而不是抛一个 SyntaxError", () => {
  assert.throws(() => parseGrokInspect("not json at all"), /不是合法 JSON/);
  assert.throws(() => parseGrokInspect("[1,2,3]"), /不是 JSON 对象/);
});

test("报告把规则文件与 token 合计列成表", () => {
  const markdown = renderAgentDiagnostics({
    inspectJson: REAL_INSPECT,
    injectedRules: "- 严禁把整个文件放进 old_string",
    workspaceRoot: "E:\\LingdongCode\\workspace\\grok-test",
    grokExecutable: "E:\\LingdongCode\\grok\\bin\\grok.exe",
    grokHome: "E:\\LingdongCode\\grok\\data",
  });
  assert.ok(markdown.includes("共 2 个文件，合计约 43 tokens"));
  assert.ok(markdown.includes("agents_md"));
  assert.ok(markdown.includes("| 35 |"));
  assert.ok(markdown.includes("严禁把整个文件"));
  // Cursor 兼容是个容易被忽略的惊喜，报告里要点出来。
  assert.ok(markdown.includes("Cursor"));
});

test("没有项目规则时给出该往哪儿放的指引，而不是只说「无」", () => {
  const markdown = renderAgentDiagnostics({
    inspectJson: JSON.stringify({ grokVersion: "0.2.118", projectInstructions: [] }),
    injectedRules: "- 规则",
  });
  assert.ok(markdown.includes("没有**发现"));
  assert.ok(markdown.includes("AGENTS.md"));
  assert.ok(markdown.includes(".grok/rules"));
});

test("注入链路断了要明确说破，这正是诊断存在的意义", () => {
  const markdown = renderAgentDiagnostics({ inspectJson: REAL_INSPECT, injectedRules: "" });
  assert.ok(markdown.includes("没有**注入"));
  assert.ok(markdown.includes("注入链路断了"));
});

test("inspect 执行失败时报告仍可用，只是缺左半边", () => {
  const markdown = renderAgentDiagnostics({
    inspectError: "无法定位 Grok 可执行文件",
    injectedRules: "- 规则在",
  });
  assert.ok(markdown.includes("无法定位 Grok 可执行文件"));
  assert.ok(markdown.includes("规则在"));
});

test("规则占用过多上下文时给出提醒", () => {
  const heavy = JSON.stringify({
    grokVersion: "0.2.118",
    projectInstructions: [
      { path: "AGENTS.md", scope: "project", fileType: "agents_md", sizeBytes: 90_000, approxTokens: 9_000 },
    ],
  });
  const markdown = renderAgentDiagnostics({ inspectJson: heavy, injectedRules: "- 规则" });
  assert.ok(markdown.includes("挤压代码上下文预算"));
});
