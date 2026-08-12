/**
 * 粘贴 / 拖入图片的会话级暂存。
 *
 * 只在内存里，不写用户仓库——早先的实现把图片存进 `.lingdong/attachments/`，
 * 结果是每粘一张图就往别人的工作区里扔一个文件，还会进 git status。
 *
 * 图片走不了 Grok 的 prompt 通道（它收下 image block 之后会静默丢掉，
 * 见 docs/image-input-plan.md），所以这里存的字节是给转发层用的：
 * 上下文里只留一个标记，转发层在请求出站前把标记换成真正的图片内容块。
 * 这也是为什么键要短且形状固定——它要嵌进提示词文本里。
 */

import { randomBytes } from "node:crypto";

export interface StoredImage {
  id: string;
  /** 用户看到的文件名，只用于界面，不参与寻址。 */
  name: string;
  /** 例如 image/png。 */
  mimeType: string;
  bytes: Buffer;
}

export const IMAGE_LIMITS = {
  /** 单张原始字节上限。 */
  bytes: 10 * 1024 * 1024,
  /** 单会话张数上限。超了明确报错，不静默丢最早的那张。 */
  count: 5,
} as const;

const ACCEPTED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);

export type ImageAddResult =
  | { ok: true; image: StoredImage }
  | { ok: false; message: string };

/** `⟦…⟧` 这对括号不会出现在正常代码或中英文里，扫描时不必担心误伤。 */
const MARKER_PREFIX = "⟦lingdong-image:";
const MARKER_SUFFIX = "⟧";

export function imageMarker(id: string): string {
  return `${MARKER_PREFIX}${id}${MARKER_SUFFIX}`;
}

/**
 * 匹配一个标记并捕获 id。id 是 12 位十六进制，长度固定便于扫描。
 *
 * 每次新建而不是导出一个常量：带 `g` 的正则有 lastIndex 状态，
 * 多个模块共用同一个实例时，一处扫到一半另一处就会从中间接着扫。
 */
export function imageMarkerPattern(): RegExp {
  return /⟦lingdong-image:([0-9a-f]{12})⟧/g;
}

export class ImageStore {
  private readonly images = new Map<string, StoredImage>();

  get size(): number {
    return this.images.size;
  }

  get isEmpty(): boolean {
    return this.images.size === 0;
  }

  /** 解析 data URL 并收下。校验在这里做完，调用方只需要把 message 转给用户。 */
  add(name: string, dataUrl: string): ImageAddResult {
    const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.*)$/i.exec(dataUrl);
    if (!match) return { ok: false, message: "无法识别的图片数据，已忽略。" };

    const mimeType = (match[1] ?? "").toLowerCase();
    if (!ACCEPTED.has(mimeType)) {
      return { ok: false, message: `暂不支持 ${mimeType} 格式的图片。` };
    }
    if (this.images.size >= IMAGE_LIMITS.count) {
      return { ok: false, message: `一轮最多带 ${IMAGE_LIMITS.count} 张图片，请先移除一张再粘贴。` };
    }

    const bytes = Buffer.from(match[2] ?? "", "base64");
    if (bytes.byteLength === 0) return { ok: false, message: "图片内容为空，已忽略。" };
    if (bytes.byteLength > IMAGE_LIMITS.bytes) {
      return {
        ok: false,
        message: `图片 ${formatBytes(bytes.byteLength)} 超过 ${formatBytes(IMAGE_LIMITS.bytes)} 上限，请先压缩。`,
      };
    }

    const image: StoredImage = { id: randomBytes(6).toString("hex"), name, mimeType, bytes };
    this.images.set(image.id, image);
    return { ok: true, image };
  }

  get(id: string): StoredImage | undefined {
    return this.images.get(id);
  }

  remove(id: string): boolean {
    return this.images.delete(id);
  }

  clear(): void {
    this.images.clear();
  }

  /** 转发层要的形状：`data:image/png;base64,...`。 */
  dataUrl(id: string): string | undefined {
    const image = this.images.get(id);
    return image ? `data:${image.mimeType};base64,${image.bytes.toString("base64")}` : undefined;
  }
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`;
}
