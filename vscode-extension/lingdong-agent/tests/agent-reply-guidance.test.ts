import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_REPLY_GUIDANCE, buildAgentReplyPrompt } from "../src/plan-research";

test("Agent 引导语要求不复述工具过程", () => {
  assert.match(AGENT_REPLY_GUIDANCE, /时间线/);
  assert.match(AGENT_REPLY_GUIDANCE, /无需复述/);
  const prompt = buildAgentReplyPrompt("修登录");
  assert.match(prompt, /【用户任务】/);
  assert.match(prompt, /修登录/);
  assert.ok(prompt.startsWith("【回复风格】"));
});
