import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  encodeGrokWorkspaceKey,
  findGrokSessionPlanPath,
  grokSessionPlanPath,
} from "../src/grok-plan-path";

test("工作区路径编码与 Grok sessions 目录一致", () => {
  const root = "c:\\Users\\Administrator\\Desktop\\测试2222";
  assert.equal(
    encodeGrokWorkspaceKey(root),
    "c%3A%5CUsers%5CAdministrator%5CDesktop%5C%E6%B5%8B%E8%AF%952222",
  );
  const plan = grokSessionPlanPath({
    grokHome: "C:\\grok-home",
    workspaceRoot: root,
    grokSessionId: "019fdfbe-2d11-7813-9d7d-73713267b03c",
  });
  assert.equal(
    plan,
    path.join(
      "C:\\grok-home",
      "sessions",
      "c%3A%5CUsers%5CAdministrator%5CDesktop%5C%E6%B5%8B%E8%AF%952222",
      "019fdfbe-2d11-7813-9d7d-73713267b03c",
      "plan.md",
    ),
  );
});

test("找不到精确工作区键时按 sessionId 扫描", async () => {
  const grokHome = "C:\\grok-home";
  const sessionId = "ses-abc";
  const hit = path.join(grokHome, "sessions", "encoded-other", sessionId, "plan.md");
  const found = await findGrokSessionPlanPath({
    grokHome,
    grokSessionId: sessionId,
    workspaceRoot: "D:\\wrong",
    exists: async (p) => p === hit || p === path.join(grokHome, "sessions"),
    listEntries: async () => [{ name: "encoded-other", isDirectory: true }],
  });
  assert.equal(found, hit);
});
