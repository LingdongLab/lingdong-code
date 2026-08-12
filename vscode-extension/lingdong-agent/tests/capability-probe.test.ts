import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
  PROBE_EXPECTED_VALUE,
  PROBE_PROMPT,
  PROBE_TOOL_NAME,
  extractChatToolCalls,
  extractResponsesToolCalls,
  judgeProbe,
  probeChatPayload,
  probeResponsesPayload,
  validateProbeArguments,
} from "../src/models/providers/capability-probe";

test("正确的工具调用判定为支持 Agent", () => {
  const verdict = judgeProbe([{ name: PROBE_TOOL_NAME, arguments: '{"value":"ok"}' }]);
  assert.deepEqual(verdict, { agentCompatible: true });
});

test("没有工具调用只标记为仅 Ask，并说明原因", () => {
  const verdict = judgeProbe([]);
  assert.equal(verdict.agentCompatible, false);
  if (!verdict.agentCompatible) {
    assert.equal(verdict.reason, "no-tool-call");
    assert.ok(verdict.detail.length > 0);
  }
});

test("工具名不对同样不算通过", () => {
  const verdict = judgeProbe([{ name: "some_other_tool", arguments: '{"value":"ok"}' }]);
  assert.equal(verdict.agentCompatible, false);
  if (!verdict.agentCompatible) assert.equal(verdict.reason, "wrong-tool-name");
});

test("strict Schema 失效时宿主仍逐项拒绝非法参数", () => {
  // 服务商文档明说 response_format 会被忽略、参数是 best-effort 传递，
  // 所以这些用例代表的是真实会发生的情况，而不是假想的恶意输入。
  assert.deepEqual(validateProbeArguments("not json at all"), { ok: false, reason: "not-json" });
  assert.deepEqual(validateProbeArguments("[]"), { ok: false, reason: "not-object" });
  assert.deepEqual(validateProbeArguments("null"), { ok: false, reason: "not-object" });
  assert.deepEqual(validateProbeArguments("{}"), { ok: false, reason: "missing-value" });
  assert.deepEqual(validateProbeArguments('{"value":123}'), { ok: false, reason: "wrong-type" });
  assert.deepEqual(validateProbeArguments('{"value":"ok","extra":1}'), { ok: false, reason: "unexpected-key" });
  assert.deepEqual(validateProbeArguments('{"value":"nope"}'), { ok: false, reason: "wrong-value" });
  assert.deepEqual(validateProbeArguments('{"value":"ok"}'), { ok: true, value: PROBE_EXPECTED_VALUE });
});

test("参数非法时经 judgeProbe 也一定落到仅 Ask", () => {
  for (const raw of ['{"value":123}', '{"value":"ok","extra":1}', "oops"]) {
    const verdict = judgeProbe([{ name: PROBE_TOOL_NAME, arguments: raw }]);
    assert.equal(verdict.agentCompatible, false, raw);
  }
});

test("探测请求体只含固定常量，不含任何项目上下文", () => {
  const chat = probeChatPayload("model-x");
  assert.deepEqual(chat.messages, [{ role: "user", content: PROBE_PROMPT }]);
  assert.equal(probeResponsesPayload("model-x").input, PROBE_PROMPT);

  for (const payload of [chat, probeResponsesPayload("model-x")]) {
    const serialized = JSON.stringify(payload);
    assert.ok(serialized.includes(PROBE_TOOL_NAME));
    // 探测请求里不该出现任何工作区、文件、会话或计划的概念。
    for (const forbidden of ["workspace", "file", "selection", "session", "plan", "timeline", "terminal"]) {
      assert.equal(serialized.toLowerCase().includes(forbidden), false, forbidden);
    }
  }
});

test("两种协议的工具调用都能解析出来", () => {
  const chat = extractChatToolCalls({
    choices: [{
      message: {
        tool_calls: [{ function: { name: PROBE_TOOL_NAME, arguments: '{"value":"ok"}' } }],
      },
    }],
  });
  assert.deepEqual(chat, [{ name: PROBE_TOOL_NAME, arguments: '{"value":"ok"}' }]);

  const responses = extractResponsesToolCalls({
    output: [
      { type: "message", content: "忽略我" },
      { type: "function_call", name: PROBE_TOOL_NAME, arguments: '{"value":"ok"}' },
    ],
  });
  assert.deepEqual(responses, [{ name: PROBE_TOOL_NAME, arguments: '{"value":"ok"}' }]);
});

test("形状不对的响应解析成空数组而不是抛错", () => {
  assert.deepEqual(extractChatToolCalls(undefined), []);
  assert.deepEqual(extractChatToolCalls({ choices: "nope" }), []);
  assert.deepEqual(extractResponsesToolCalls({ output: [{ type: "function_call" }] }), []);
});

test("能力检测模块不 import fs / child_process / vscode", () => {
  const file = path.join(process.cwd(), "src", "models", "providers", "capability-probe.ts");
  const source = readFileSync(file, "utf8");
  const imports = [...source.matchAll(/^\s*import[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]);
  // 断言 import 清单而不是靠人工审查：这条约束是「检测无副作用」的结构性保证。
  assert.deepEqual(imports, []);
  for (const forbidden of ["node:fs", "node:child_process", "vscode", "node:os", "node:net"]) {
    assert.equal(source.includes(`"${forbidden}"`), false, forbidden);
  }
});
