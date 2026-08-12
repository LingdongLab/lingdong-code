/**
 * 模型目录解析的纯函数测试。
 *
 * 重点不是「正常数据能解析」，而是「异常数据不会让整份目录失败」：
 * 服务商随时可能加字段、改结构，或者混进一条坏数据，
 * 而用户看到的应该是少了一条，不是模型中心打不开。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
  CATALOG_TTL_MS,
  isCatalogFresh,
  parsePoeCatalog,
  preferredProtocol,
  protocolsFromEndpoints,
  supportsImageInput,
} from "../src/models/providers/poe-catalog";

/** 一份贴近真实响应的目录。 */
const SAMPLE = {
  object: "list",
  data: [
    {
      id: "Claude-Sonnet-4.5",
      object: "model",
      created: 1_730_000_000,
      owned_by: "anthropic",
      description: "Anthropic 的通用模型。",
      supported_endpoints: ["/v1/chat/completions", "/v1/responses"],
      supported_features: ["tool_calling", "streaming", "image_input"],
      context_length: 200_000,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      pricing: { text_input: 30, text_output: 150 },
    },
    {
      id: "GPT-4o-mini",
      owned_by: "openai",
      supported_endpoints: ["/v1/chat/completions"],
      supported_features: ["streaming"],
      context_length: 128_000,
    },
  ],
};

test("解析真实形状的目录：字段逐条落位", () => {
  const result = parsePoeCatalog(SAMPLE);

  assert.equal(result.skipped, 0);
  assert.equal(result.entries.length, 2);
  const first = result.entries[0]!;
  assert.equal(first.id, "Claude-Sonnet-4.5");
  assert.equal(first.vendor, "anthropic");
  assert.equal(first.contextWindow, 200_000);
  assert.deepEqual(first.protocols, ["responses", "chat_completions"]);
  assert.deepEqual(first.features, ["tool_calling", "streaming", "image_input"]);
  assert.deepEqual(first.inputModalities, ["text", "image"]);
  assert.deepEqual(first.outputModalities, ["text"]);
  assert.ok(first.pricingNote?.includes("text_input 30"));
});

test("文生图模型不算能看图：image 在输出侧不该放行图片输入", () => {
  const result = parsePoeCatalog({
    data: [
      {
        id: "FLUX-pro",
        architecture: { input_modalities: ["text"], output_modalities: ["image"] },
      },
    ],
  });

  const entry = result.entries[0]!;
  assert.deepEqual(entry.inputModalities, ["text"]);
  assert.deepEqual(entry.outputModalities, ["image"]);
  assert.equal(supportsImageInput(entry), false);
});

test("input_modalities 含 image 才算能看图", () => {
  const result = parsePoeCatalog({
    data: [
      { id: "Vision-Bot", architecture: { input_modalities: ["text", "image"] } },
      { id: "Text-Bot", architecture: { input_modalities: ["text"] } },
      { id: "Silent-Bot" },
    ],
  });

  assert.equal(supportsImageInput(result.entries[0]!), true);
  assert.equal(supportsImageInput(result.entries[1]!), false);
  // 没声明就当不支持：宁可让用户手动打开，也好过把图发出去被服务商拒。
  assert.equal(supportsImageInput(result.entries[2]!), false);
});

test("裸 modalities 按输入处理", () => {
  const result = parsePoeCatalog({
    data: [{ id: "Legacy-Bot", architecture: { modalities: ["text", "image"] } }],
  });

  assert.equal(supportsImageInput(result.entries[0]!), true);
});

test("除 id 外全部可选：缺字段的条目照样进目录", () => {
  const result = parsePoeCatalog({ data: [{ id: "Bare-Bot" }] });

  assert.equal(result.skipped, 0);
  const entry = result.entries[0]!;
  assert.equal(entry.id, "Bare-Bot");
  assert.equal(entry.vendor, "");
  assert.equal(entry.description, undefined);
  assert.equal(entry.contextWindow, undefined);
  assert.deepEqual(entry.protocols, []);
  assert.deepEqual(entry.features, []);
});

test("未知字段一律忽略，不影响已知字段", () => {
  const result = parsePoeCatalog({
    data: [{ id: "New-Bot", owned_by: "x", future_field: { nested: true }, another: [1, 2, 3] }],
  });

  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]!.vendor, "x");
});

test("坏条目只累加 skipped，不让整份目录失败", () => {
  const result = parsePoeCatalog({
    data: [null, "not-an-object", { object: "model" }, { id: 42 }, SAMPLE.data[0]],
  });

  assert.equal(result.entries.length, 1);
  assert.equal(result.skipped, 4);
});

test("id 无法用于请求时计入 skipped：加不进来的条目不该显示成可添加", () => {
  const result = parsePoeCatalog({
    data: [
      { id: "../../etc/passwd" },
      { id: "has space" },
      { id: "line\nbreak" },
      { id: "Good-Bot" },
    ],
  });

  assert.deepEqual(result.entries.map((entry) => entry.id), ["Good-Bot"]);
  assert.equal(result.skipped, 3);
});

test("重复 id 只保留第一条", () => {
  const result = parsePoeCatalog({
    data: [{ id: "Dup", owned_by: "first" }, { id: "Dup", owned_by: "second" }],
  });

  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]!.vendor, "first");
});

test("裸数组与不认识的结构都不会抛异常", () => {
  assert.equal(parsePoeCatalog([{ id: "Bare-List-Bot" }]).entries.length, 1);
  assert.deepEqual(parsePoeCatalog(undefined), { entries: [], skipped: 0 });
  assert.deepEqual(parsePoeCatalog({ error: "nope" }), { entries: [], skipped: 0 });
});

test("supported_endpoints 决定协议，写法不统一也能认出来", () => {
  assert.deepEqual(protocolsFromEndpoints(["/v1/responses"]), ["responses"]);
  assert.deepEqual(protocolsFromEndpoints(["chat_completions"]), ["chat_completions"]);
  // 响应里的顺序不影响输出：固定 Responses 在前。
  assert.deepEqual(protocolsFromEndpoints(["/chat/completions", "/responses"]), [
    "responses",
    "chat_completions",
  ]);
  assert.deepEqual(protocolsFromEndpoints(["/v1/images"]), []);
});

test("首选协议优先 Responses，没声明时交给协议测试决定", () => {
  const [claude, gpt] = parsePoeCatalog(SAMPLE).entries;
  assert.equal(preferredProtocol(claude!), "responses");
  assert.equal(preferredProtocol(gpt!), "chat_completions");
  assert.equal(preferredProtocol(parsePoeCatalog({ data: [{ id: "Bare" }] }).entries[0]!), undefined);
});

test("12 小时新鲜度：过期、未同步与时钟倒流都算不新鲜", () => {
  const now = 10_000_000_000;
  assert.equal(CATALOG_TTL_MS, 12 * 60 * 60 * 1000);
  assert.equal(isCatalogFresh(now - 1_000, now), true);
  assert.equal(isCatalogFresh(now - CATALOG_TTL_MS + 1, now), true);
  assert.equal(isCatalogFresh(now - CATALOG_TTL_MS, now), false);
  assert.equal(isCatalogFresh(undefined, now), false);
  // 用户改过系统时钟：宁可多拉一次，也不要长期用一份判断不了年龄的缓存。
  assert.equal(isCatalogFresh(now + 60_000, now), false);
});

test("模块保持纯净：不 import fs、child_process 或 vscode", () => {
  const source = readFileSync(
    path.join(__dirname, "..", "src", "models", "providers", "poe-catalog.ts"),
    "utf8",
  );
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);

  assert.ok(imports.length > 0, "至少应当有类型 import，否则这条断言是空的");
  for (const specifier of imports) {
    assert.ok(
      !specifier.startsWith("node:") && specifier !== "vscode",
      `目录解析不应依赖 ${specifier}`,
    );
  }
});
