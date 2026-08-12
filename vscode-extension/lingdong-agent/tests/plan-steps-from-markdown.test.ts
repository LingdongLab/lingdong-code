import assert from "node:assert/strict";
import test from "node:test";
import { reconcilePlanStepsFromMarkdown } from "../src/plan-steps-from-markdown";

test("checkbox 列表成为 Tasks 权威来源", () => {
  const steps = reconcilePlanStepsFromMarkdown(
    "# 计划\n\n- [ ] 改路由\n- [x] 补测试\n- [ ] 写文档\n",
    [{ id: "step-1", title: "旧步骤", files: [] }],
  );
  assert.deepEqual(steps.map((s) => s.title), ["改路由", "补测试", "写文档"]);
});

test("删除「下一步」章节后对应旧步骤被清掉", () => {
  const raw = `# 调研报告

## 一、它是什么
简介

## 二、功能清单
表格

## 三、数据与配置
说明
`;
  const previous = [
    { id: "s1", title: "克隆到本地跑起来（需 Node 22 + pnpm 9 + Rust，或直接用 Releases 安装包）", files: [] },
    { id: "s2", title: "只读源码学习", files: [] },
    { id: "s3", title: "参与贡献 / 二开", files: [] },
    { id: "s4", title: "仅参考其设计", files: [] },
  ];
  const steps = reconcilePlanStepsFromMarkdown(raw, previous);
  assert.equal(steps.length, 0);
});

test("下一步章节列表被解析为步骤，并保留同名 id", () => {
  const raw = `# 报告

## 五、结论与下一步建议
1. **克隆到本地跑起来**
2. 只读源码学习
`;
  const steps = reconcilePlanStepsFromMarkdown(raw, [
    { id: "keep-me", title: "克隆到本地跑起来", files: ["a.ts"] },
  ]);
  assert.equal(steps.length, 2);
  assert.equal(steps[0]?.id, "keep-me");
  assert.equal(steps[0]?.title, "克隆到本地跑起来");
  assert.deepEqual(steps[0]?.files, ["a.ts"]);
  assert.equal(steps[1]?.title, "只读源码学习");
});
