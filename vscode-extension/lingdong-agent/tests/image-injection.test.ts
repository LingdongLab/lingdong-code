/**
 * 图片注入的纯函数测试。
 *
 * 这里改写的是 Grok 拼出来的请求体，所以断言重心不在「正常情况能注入」，
 * 而在两条不能破的底线：认不出的结构一律不动，以及任何没换成图片的标记都不许漏出去。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { hasImageMarker, injectImages } from "../src/models/providers/image-injection";
import { imageMarker } from "../src/services/image-store";

const ID = "ab12cd34ef56";
const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";
const MARKER = imageMarker(ID);

const resolve = (id: string): string | undefined => (id === ID ? DATA_URL : undefined);
/** 图已经被移出暂存的情形。 */
const resolveNothing = (): undefined => undefined;

function rewrite(payload: unknown, resolver = resolve): { body: Record<string, unknown>; injected: number } {
  const result = injectImages(JSON.stringify(payload), resolver);
  assert.ok(result, "带标记的请求体应当被改写");
  return { body: JSON.parse(result.body) as Record<string, unknown>, injected: result.injected };
}

test("不带标记的请求体原样放过，连解析都不做", () => {
  const body = JSON.stringify({ messages: [{ role: "user", content: "普通问题" }] });
  assert.equal(injectImages(body, resolve), undefined);
  assert.equal(hasImageMarker(body), false);
});

test("chat_completions：字符串 content 变成文本 + 图片两块", () => {
  const { body, injected } = rewrite({
    model: "claude",
    messages: [
      { role: "system", content: "你是助手" },
      { role: "user", content: `这张图是什么颜色 ${MARKER}` },
    ],
  });

  assert.equal(injected, 1);
  const messages = body.messages as Array<Record<string, unknown>>;
  assert.equal(messages[0]?.content, "你是助手", "system 消息不该被动");
  assert.deepEqual(messages[1]?.content, [
    { type: "text", text: "这张图是什么颜色 " },
    { type: "image_url", image_url: { url: DATA_URL } },
  ]);
});

test("responses：用 input_text / input_image 这套形状", () => {
  const { body, injected } = rewrite({
    model: "claude",
    input: [{ role: "user", content: [{ type: "input_text", text: `看图 ${MARKER}` }] }],
  });

  assert.equal(injected, 1);
  const input = body.input as Array<Record<string, unknown>>;
  assert.deepEqual(input[0]?.content, [
    { type: "input_text", text: "看图 " },
    { type: "input_image", image_url: DATA_URL },
  ]);
});

test("标记前后的文字都保留，位置也不变", () => {
  const { body } = rewrite({
    messages: [{ role: "user", content: `前面 ${MARKER} 后面` }],
  });

  const content = (body.messages as Array<Record<string, unknown>>)[0]?.content;
  assert.deepEqual(content, [
    { type: "text", text: "前面 " },
    { type: "image_url", image_url: { url: DATA_URL } },
    { type: "text", text: " 后面" },
  ]);
});

test("多张图片按出现顺序注入", () => {
  const second = "0011223344ff";
  const { injected, body } = rewrite(
    { messages: [{ role: "user", content: `${MARKER}${imageMarker(second)}` }] },
    (id) => (id === ID ? DATA_URL : id === second ? "data:image/gif;base64,R0lGOD" : undefined),
  );

  assert.equal(injected, 2);
  assert.deepEqual((body.messages as Array<Record<string, unknown>>)[0]?.content, [
    { type: "image_url", image_url: { url: DATA_URL } },
    { type: "image_url", image_url: { url: "data:image/gif;base64,R0lGOD" } },
  ]);
});

test("历史轮次里的老标记照样注入：Grok 每轮都会重发完整对话", () => {
  const { injected, body } = rewrite({
    messages: [
      { role: "user", content: `第一轮的图 ${MARKER}` },
      { role: "assistant", content: "是红色的" },
      { role: "user", content: "那第二张呢" },
    ],
  });

  assert.equal(injected, 1);
  const messages = body.messages as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(messages[0]?.content));
  assert.equal(messages[1]?.content, "是红色的");
});

test("图片已被移出暂存时删掉标记，不把内部字符串漏给模型", () => {
  const { injected, body } = rewrite(
    { messages: [{ role: "user", content: `这张图 ${MARKER} 呢` }] },
    resolveNothing,
  );

  assert.equal(injected, 0);
  assert.equal((body.messages as Array<Record<string, unknown>>)[0]?.content, "这张图  呢");
});

test("认不出的结构不注入，但标记仍然被清干净", () => {
  const { injected, body } = rewrite({ prompt: `自造字段 ${MARKER}` });

  assert.equal(injected, 0);
  assert.equal(body.prompt, "自造字段 ");
});

test("assistant 消息里的标记只清理，不注入", () => {
  const { injected, body } = rewrite({
    messages: [{ role: "assistant", content: `我看到了 ${MARKER}` }],
  });

  assert.equal(injected, 0);
  assert.equal((body.messages as Array<Record<string, unknown>>)[0]?.content, "我看到了 ");
});

test("请求体不是合法 JSON 时不硬改，只抹掉标记", () => {
  const result = injectImages(`{ 坏掉的 ${MARKER}`, resolve);

  assert.ok(result);
  assert.equal(result.injected, 0);
  assert.equal(result.body.includes("lingdong-image"), false);
});

test("已经是内容块数组的 user 消息也能就地拆开", () => {
  const { injected, body } = rewrite({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "先说一句" },
        { type: "text", text: `再看图 ${MARKER}` },
      ],
    }],
  });

  assert.equal(injected, 1);
  assert.deepEqual((body.messages as Array<Record<string, unknown>>)[0]?.content, [
    { type: "text", text: "先说一句" },
    { type: "text", text: "再看图 " },
    { type: "image_url", image_url: { url: DATA_URL } },
  ]);
});
