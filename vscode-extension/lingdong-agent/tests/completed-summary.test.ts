import assert from "node:assert/strict";
import test from "node:test";
import { buildCompletedSummary, parseTestsPassedHint } from "../src/services/completed-summary";

test("无修改不显示文件行；无测试输出不显示测试行", () => {
  assert.equal(buildCompletedSummary({ filesChanged: 0 }), undefined);
  assert.deepEqual(buildCompletedSummary({ filesChanged: 3 }), { filesChanged: 3 });
});

test("单一 regex 取测试通过数；匹配失败整行消失", () => {
  assert.equal(parseTestsPassedHint("Tests  12 passed (12)"), 12);
  assert.equal(parseTestsPassedHint("no numbers here"), undefined);
  assert.deepEqual(
    buildCompletedSummary({ filesChanged: 2, commandOutput: "294 passed" }),
    { filesChanged: 2, testsPassed: 294 },
  );
  assert.deepEqual(
    buildCompletedSummary({ filesChanged: 1, commandOutput: "all green" }),
    { filesChanged: 1 },
  );
});
