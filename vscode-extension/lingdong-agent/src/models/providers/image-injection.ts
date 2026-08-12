/**
 * 把提示词里的图片标记换成真正的图片内容块。
 *
 * 为什么要在转发层做这件事：Grok 的 prompt 通道会收下 image block 然后静默丢掉
 * （三种协议/模型组合都实测过，见 docs/image-input-plan.md）。所以图片不走 Grok，
 * 而是由上下文层埋一个 `⟦lingdong-image:<id>⟧` 标记，等请求快出站时在这里替换。
 *
 * 三条规则刻在实现里：
 *
 * - **认不出的结构一律不改。** 我们改写的是别人拼的请求体，Grok 换版本改了形状时，
 *   宁可这一轮没图，也不能发一个半成品出去。
 * - **任何没换成图片的标记都要删掉。** `⟦lingdong-image:ab12cd34ef56⟧` 漏进对话
 *   对用户是纯粹的困惑源，比少一张图糟得多。
 * - **只碰 user 消息。** system 与 assistant 里出现标记只可能是回声，删掉即可。
 */

import { imageMarkerPattern } from "../../services/image-store";

/** 按 id 取 `data:image/png;base64,...`；取不到表示这张图已经不在暂存里。 */
export type ImageResolver = (id: string) => string | undefined;

export interface InjectionResult {
  body: string;
  /** 真正塞进去的图片数；0 表示只做了标记清理。 */
  injected: number;
}

/** 便宜的预筛：绝大多数请求根本不带标记，不该为它们付出 JSON.parse 的代价。 */
export function hasImageMarker(body: string): boolean {
  return body.includes("⟦lingdong-image:") || body.includes("\\u27e6lingdong-image:");
}

/**
 * 改写请求体。返回 undefined 表示无需改动，调用方原样转发。
 *
 * 解析失败时不会放弃清理：标记会被从原始文本里抹掉再返回，因为「漏出内部字符串」
 * 是这条路径上唯一不可接受的结果。
 */
export function injectImages(body: string, resolve: ImageResolver): InjectionResult | undefined {
  if (!hasImageMarker(body)) return undefined;

  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    return { body: stripMarkersFromText(body), injected: 0 };
  }

  const injected = injectIntoMessages(root, resolve);
  // 结构没认出来、id 查不到、或者标记落在 assistant 里——剩下的一律清干净。
  stripMarkersDeep(root);
  return { body: JSON.stringify(root), injected };
}

function injectIntoMessages(root: unknown, resolve: ImageResolver): number {
  if (!isRecord(root)) return 0;

  // chat/completions 用 messages，responses 用 input；两者的图片块形状不同。
  if (Array.isArray(root.messages)) {
    return injectIntoList(root.messages, resolve, "chat");
  }
  if (Array.isArray(root.input)) {
    return injectIntoList(root.input, resolve, "responses");
  }
  if (typeof root.input === "string" && hasImageMarker(root.input)) {
    const parts = splitIntoParts(root.input, resolve, "responses");
    if (parts.injected === 0) return 0;
    root.input = parts.blocks;
    return parts.injected;
  }
  return 0;
}

type Shape = "chat" | "responses";

function injectIntoList(list: unknown[], resolve: ImageResolver, shape: Shape): number {
  let injected = 0;
  for (const entry of list) {
    if (!isRecord(entry) || entry.role !== "user") continue;

    if (typeof entry.content === "string") {
      if (!hasImageMarker(entry.content)) continue;
      const parts = splitIntoParts(entry.content, resolve, shape);
      if (parts.injected === 0) continue;
      entry.content = parts.blocks;
      injected += parts.injected;
      continue;
    }

    if (!Array.isArray(entry.content)) continue;
    const rebuilt: unknown[] = [];
    let changed = false;
    for (const block of entry.content) {
      const text = textOf(block, shape);
      if (text === undefined || !hasImageMarker(text)) {
        rebuilt.push(block);
        continue;
      }
      const parts = splitIntoParts(text, resolve, shape);
      if (parts.injected === 0) {
        rebuilt.push(block);
        continue;
      }
      rebuilt.push(...parts.blocks);
      injected += parts.injected;
      changed = true;
    }
    if (changed) entry.content = rebuilt;
  }
  return injected;
}

/** 只认这一层里我们自己会生成的文本块形状，别的原样保留。 */
function textOf(block: unknown, shape: Shape): string | undefined {
  if (!isRecord(block)) return undefined;
  const expected = shape === "chat" ? "text" : "input_text";
  if (block.type !== expected) return undefined;
  return typeof block.text === "string" ? block.text : undefined;
}

interface SplitResult {
  blocks: unknown[];
  injected: number;
}

/**
 * 按标记把一段文本切成 文本 / 图片 / 文本 …
 *
 * 查不到的 id 直接丢弃那个标记（文本继续拼接），因为它对应的图已经不在暂存里了。
 */
function splitIntoParts(text: string, resolve: ImageResolver, shape: Shape): SplitResult {
  const blocks: unknown[] = [];
  let injected = 0;
  let cursor = 0;
  let pending = "";

  const pattern = imageMarkerPattern();
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    pending += text.slice(cursor, match.index);
    cursor = match.index + match[0].length;

    const dataUrl = resolve(match[1] ?? "");
    if (!dataUrl) continue;

    if (pending.trim() !== "") blocks.push(textBlock(pending, shape));
    pending = "";
    blocks.push(imageBlock(dataUrl, shape));
    injected += 1;
  }

  pending += text.slice(cursor);
  if (pending.trim() !== "") blocks.push(textBlock(pending, shape));
  return { blocks, injected };
}

function textBlock(text: string, shape: Shape): unknown {
  return shape === "chat" ? { type: "text", text } : { type: "input_text", text };
}

function imageBlock(dataUrl: string, shape: Shape): unknown {
  return shape === "chat"
    ? { type: "image_url", image_url: { url: dataUrl } }
    : { type: "input_image", image_url: dataUrl };
}

/** 兜底清理：解析出来的整棵树里，任何字符串上残留的标记都抹掉。 */
function stripMarkersDeep(value: unknown): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (typeof item === "string") value[index] = stripMarkers(item);
      else stripMarkersDeep(item);
    }
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") value[key] = stripMarkers(item);
    else stripMarkersDeep(item);
  }
}

function stripMarkers(text: string): string {
  return hasImageMarker(text) ? text.replace(imageMarkerPattern(), "") : text;
}

/** JSON 解析失败时用：连转义写法一起抹掉，因为那时候看到的是原始字节。 */
function stripMarkersFromText(body: string): string {
  return body
    .replace(imageMarkerPattern(), "")
    .replace(/\\u27e6lingdong-image:[0-9a-f]{12}\\u27e7/gi, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
