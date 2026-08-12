/**
 * 已经在面板里给过明确提示的失败。
 *
 * 拉起连接的编排层在抛异常之前，往往已经推了一张带按钮的卡（缺凭据时的
 * 「配置密钥…」就是）。上层若再按普通异常补一张红卡，同一句话会出现两遍；
 * 首启缺凭据那条本来被有意降成灰色提示，红卡会把这个意图整个抵消掉。
 * 带上这个标记的异常，上层只更新连接状态，不再重复发卡。
 */
export class SurfacedError extends Error {
  readonly surfaced = true;

  constructor(message: string) {
    super(message);
    this.name = "SurfacedError";
  }
}

/** 跨模块实例可能来自不同的类副本，按标记位判定而不是 instanceof。 */
export function isSurfaced(error: unknown): boolean {
  return error instanceof Error && (error as { surfaced?: unknown }).surfaced === true;
}
