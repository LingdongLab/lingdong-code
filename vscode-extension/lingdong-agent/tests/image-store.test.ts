/**
 * 图片暂存的边界行为。
 *
 * 这里要证明的是「不写用户仓库」之外的另外两件事：限额是真的拦得住，
 * 以及图片被移除后字节真的被回收——否则一个开着不关的会话会把粘过的图全留在内存里。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { IMAGE_LIMITS, ImageStore, imageMarker, imageMarkerPattern } from "../src/services/image-store";

/** 一张体积可控的假 PNG；内容不需要是合法图像，store 不解码。 */
function pngDataUrl(bytes: number): string {
  return `data:image/png;base64,${Buffer.alloc(bytes, 1).toString("base64")}`;
}

test("收下合法图片并给出可嵌进提示词的标记", () => {
  const store = new ImageStore();
  const result = store.add("shot.png", pngDataUrl(64));

  assert.ok(result.ok);
  assert.equal(result.image.mimeType, "image/png");
  assert.equal(result.image.bytes.byteLength, 64);
  assert.match(imageMarker(result.image.id), imageMarkerPattern());
  assert.equal(store.dataUrl(result.image.id), pngDataUrl(64));
});

test("超过单张上限时报错，不静默截断", () => {
  const store = new ImageStore();
  const result = store.add("huge.png", pngDataUrl(IMAGE_LIMITS.bytes + 1));

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.message.includes("上限"));
  assert.equal(store.size, 0);
});

test("超过张数上限时报错，已收下的不受影响", () => {
  const store = new ImageStore();
  for (let index = 0; index < IMAGE_LIMITS.count; index += 1) {
    assert.equal(store.add(`${index}.png`, pngDataUrl(16)).ok, true);
  }

  const overflow = store.add("one-too-many.png", pngDataUrl(16));

  assert.equal(overflow.ok, false);
  assert.equal(store.size, IMAGE_LIMITS.count);
});

test("空内容与不认识的格式都不收", () => {
  const store = new ImageStore();

  assert.equal(store.add("empty.png", "data:image/png;base64,").ok, false);
  assert.equal(store.add("doc.pdf", "data:application/pdf;base64,AAAA").ok, false);
  assert.equal(store.add("junk", "not-a-data-url").ok, false);
  assert.equal(store.size, 0);
});

test("移除与清空都会真的丢掉字节", () => {
  const store = new ImageStore();
  const first = store.add("a.png", pngDataUrl(16));
  const second = store.add("b.png", pngDataUrl(16));
  assert.ok(first.ok && second.ok);

  assert.equal(store.remove(first.image.id), true);
  assert.equal(store.get(first.image.id), undefined);
  assert.equal(store.dataUrl(first.image.id), undefined);
  assert.equal(store.size, 1);

  store.clear();
  assert.equal(store.isEmpty, true);
  assert.equal(store.get(second.image.id), undefined);
});

test("标记形状固定，普通文本扫不出误报", () => {
  const store = new ImageStore();
  const added = store.add("a.png", pngDataUrl(16));
  assert.ok(added.ok);

  const text = `看看这张图 ${imageMarker(added.image.id)} 谢谢`;
  const found = [...text.matchAll(imageMarkerPattern())].map((match) => match[1]);
  assert.deepEqual(found, [added.image.id]);

  // 长得像但 id 不合规的一律不匹配，免得把用户写的内容当成标记吃掉。
  const noise = "⟦lingdong-image:xyz⟧ 和 ⟦lingdong-image:0123456789abcdef⟧";
  assert.deepEqual([...noise.matchAll(imageMarkerPattern())], []);
});
