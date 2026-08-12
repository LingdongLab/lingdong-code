export interface QueuedPermission<T> {
  requestId: string;
  item: T;
  queuedAt: number;
}

const MAX_HANDLED = 500;
const MAX_QUEUE = 50;

/**
 * 权限请求队列：任何时刻只向 UI 暴露一个 current 卡片，
 * 其余请求排队等待，避免多张卡片同时可点造成误操作。
 */
export class PermissionQueue<T> {
  private items: QueuedPermission<T>[] = [];
  private readonly handled: string[] = [];
  private readonly handledSet = new Set<string>();

  get current(): QueuedPermission<T> | undefined {
    return this.items[0];
  }

  /** 队列中除当前卡片外还在等待的数量。 */
  get waiting(): number {
    return Math.max(0, this.items.length - 1);
  }

  get size(): number {
    return this.items.length;
  }

  isHandled(requestId: string): boolean {
    return this.handledSet.has(requestId);
  }

  has(requestId: string): boolean {
    return this.items.some((entry) => entry.requestId === requestId);
  }

  /** 重复的 requestId、已处理过的 requestId 与超长队列都会被拒绝入队。 */
  enqueue(requestId: string, item: T, now = Date.now()): boolean {
    if (requestId.length === 0) return false;
    if (this.handledSet.has(requestId)) return false;
    if (this.has(requestId)) return false;
    if (this.items.length >= MAX_QUEUE) return false;
    this.items.push({ requestId, item, queuedAt: now });
    return true;
  }

  /** 只允许处理当前卡片；其他 requestId 视为伪造或过期，返回 undefined。 */
  resolve(requestId: string): QueuedPermission<T> | undefined {
    const current = this.items[0];
    if (!current || current.requestId !== requestId) return undefined;
    this.items.shift();
    this.markHandled(requestId);
    return current;
  }

  /** 超时失效：无论是否是当前卡片都从队列移除。 */
  expire(requestId: string): QueuedPermission<T> | undefined {
    const index = this.items.findIndex((entry) => entry.requestId === requestId);
    if (index < 0) return undefined;
    const [entry] = this.items.splice(index, 1);
    this.markHandled(requestId);
    return entry;
  }

  clear(): QueuedPermission<T>[] {
    const dropped = this.items;
    this.items = [];
    for (const entry of dropped) this.markHandled(entry.requestId);
    return dropped;
  }

  private markHandled(requestId: string): void {
    if (this.handledSet.has(requestId)) return;
    this.handledSet.add(requestId);
    this.handled.push(requestId);
    while (this.handled.length > MAX_HANDLED) {
      const oldest = this.handled.shift();
      if (oldest !== undefined) this.handledSet.delete(oldest);
    }
  }
}
