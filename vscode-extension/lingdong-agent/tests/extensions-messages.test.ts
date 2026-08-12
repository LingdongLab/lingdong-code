import assert from "node:assert/strict";
import test from "node:test";
import {
  draftToUpsertInput,
  parseExtensionsMessage,
} from "../src/extensions-messages";

test("合法消息通过解析", () => {
  assert.deepEqual(parseExtensionsMessage({ type: "ready" }), { type: "ready" });
  assert.deepEqual(
    parseExtensionsMessage({ type: "installSkillFromFolder", scope: "user" }),
    { type: "installSkillFromFolder", scope: "user" },
  );
  assert.deepEqual(
    parseExtensionsMessage({ type: "setSkillEnabled", name: "demo", enabled: false }),
    { type: "setSkillEnabled", name: "demo", enabled: false },
  );
});

test("非法 MCP 名与缺失字段被丢弃", () => {
  assert.equal(parseExtensionsMessage({ type: "upsertMcp", draft: { name: "bad name", transport: "stdio", enabled: true } }), undefined);
  assert.equal(parseExtensionsMessage({ type: "setMcpEnabled", id: "x" }), undefined);
  assert.equal(parseExtensionsMessage({ type: "removeSkill", name: "x" }), undefined);
});

test("规则与记忆消息：合法的通过，缺字段或错枚举的丢弃", () => {
  assert.deepEqual(
    parseExtensionsMessage({ type: "openRuleFile", path: " E:/repo/AGENTS.md " }),
    { type: "openRuleFile", path: "E:/repo/AGENTS.md" },
  );
  assert.deepEqual(
    parseExtensionsMessage({ type: "createProjectAgents" }),
    { type: "createProjectAgents" },
  );
  assert.deepEqual(
    parseExtensionsMessage({ type: "createRule", scope: "user", title: " 风格 " }),
    { type: "createRule", scope: "user", title: "风格" },
  );
  assert.deepEqual(
    parseExtensionsMessage({ type: "setLspEnabled", id: "typescript", enabled: false }),
    { type: "setLspEnabled", id: "typescript", enabled: false },
  );
  assert.deepEqual(
    parseExtensionsMessage({ type: "setMemoryEnabled", enabled: true }),
    { type: "setMemoryEnabled", enabled: true },
  );

  assert.equal(parseExtensionsMessage({ type: "openRuleFile", path: "  " }), undefined);
  assert.equal(parseExtensionsMessage({ type: "createRule", scope: "global", title: "x" }), undefined);
  assert.equal(parseExtensionsMessage({ type: "createRule", scope: "project", title: " " }), undefined);
  assert.equal(parseExtensionsMessage({ type: "setLspEnabled", id: "typescript" }), undefined);
  assert.equal(parseExtensionsMessage({ type: "setMemoryEnabled", enabled: "yes" }), undefined);
});

test("draft 转 upsert 入参：参数与密钥文本分行解析", () => {
  const input = draftToUpsertInput({
    name: "my_tools",
    transport: "stdio",
    enabled: true,
    command: "npx",
    argsText: "-y\ndemo-mcp",
    envText: "FOO=bar\n# comment\n",
    secretEnvText: "TOKEN=secret-value\nCLEAR=\n",
  });
  assert.equal(input.name, "my_tools");
  assert.deepEqual(input.args, ["-y", "demo-mcp"]);
  assert.deepEqual(input.env, { FOO: "bar" });
  assert.deepEqual(input.secretEnv, { TOKEN: "secret-value", CLEAR: "" });
});
