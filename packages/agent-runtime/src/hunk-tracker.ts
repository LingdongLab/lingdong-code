/**
 * Grok 逐 hunk 审阅通道（`_x.ai/hunk-tracker/*`）。
 *
 * 前提是 initialize 的 clientCapabilities._meta 声明了 `x.ai/hunkTracker`，
 * Grok 才会为会话开追踪器（见 acp-client.ts start()）。方法名、参数与响应
 * 形状都来自源码（grok-src hunk_tracker.rs）并经探针在 0.2.118 与自建
 * 1.0.0 上实测（.build/probe-caps-*.json）。
 *
 * 线协议注意：扩展方法要带 `_` 前缀；响应是 `{ result: {...} }` 再包一层，
 * 这里统一剥掉，调用方拿到的就是业务载荷。
 */

export interface HunkLineInfo {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/** 单个 hunk。oldText 为 null 表示纯新增；patch 只在按路径查询时给出。 */
export interface GrokHunk {
  id: string;
  path: string;
  lineInfo: HunkLineInfo;
  /** { type: "agentEdit" | "external" | ... }；来源归属，UI 可标「手改」。 */
  source: { type: string };
  oldText: string | null;
  newText: string;
  patch: string | null;
  createdAt: string;
}

export interface HunkFileSummary {
  path: string;
  isAgentFile: boolean;
  staged: boolean;
  hunkCount: number;
  additions: number;
  deletions: number;
}

export interface HunkFilePayload {
  hunks: GrokHunk[];
  baselineContent?: string;
  currentContent?: string;
}

export interface HunkActionResult {
  success: boolean;
  error?: string;
  affectedCount?: number;
}

export type HunkActionKind = "accept" | "reject";

export type HunkCapability = "available" | "unavailable" | "unknown";

export interface HunkRequestClient {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

function isMethodNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\b-32601\b/.test(error.message) || /method not found/i.test(error.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class HunkTrackerClient {
  private capability: HunkCapability = "unknown";

  constructor(
    private readonly client: HunkRequestClient,
    private readonly options: { sessionId(): string | undefined },
  ) {}

  get hunkCapability(): HunkCapability {
    return this.capability;
  }

  /** 会话切换后能力要重测：新会话可能换了模式甚至换了二进制。 */
  resetCapability(): void {
    this.capability = "unknown";
  }

  /** 变更文件汇总。-32601 记 unavailable 并返回空表，其余错误上抛。 */
  async getFiles(): Promise<HunkFileSummary[]> {
    const body = await this.call<{ files?: HunkFileSummary[] }>("get-files", {});
    if (body === undefined) return [];
    return Array.isArray(body.files) ? body.files : [];
  }

  /** 某个文件（绝对路径）的 hunk 明细，含基线/当前全文。 */
  async getHunks(path: string): Promise<HunkFilePayload | undefined> {
    const body = await this.call<{
      hunks?: GrokHunk[];
      baselineContent?: string;
      currentContent?: string;
    }>("get-hunks", { path });
    if (body === undefined) return undefined;
    return {
      hunks: Array.isArray(body.hunks) ? body.hunks : [],
      ...(typeof body.baselineContent === "string" ? { baselineContent: body.baselineContent } : {}),
      ...(typeof body.currentContent === "string" ? { currentContent: body.currentContent } : {}),
    };
  }

  async hunkAction(hunkId: string, action: HunkActionKind): Promise<HunkActionResult> {
    return this.action("hunk-action", { hunkId, action });
  }

  async fileAction(path: string, action: HunkActionKind): Promise<HunkActionResult> {
    return this.action("file-action", { path, action });
  }

  async turnAction(promptIndex: number, action: HunkActionKind): Promise<HunkActionResult> {
    return this.action("turn-action", { promptIndex, action });
  }

  async allAction(action: HunkActionKind): Promise<HunkActionResult> {
    return this.action("all-action", { action });
  }

  private async action(method: string, params: Record<string, unknown>): Promise<HunkActionResult> {
    const body = await this.call<HunkActionResult>(method, params);
    if (body === undefined) return { success: false, error: "当前 Grok 不支持逐 hunk 操作。" };
    return {
      success: body.success === true,
      ...(typeof body.error === "string" ? { error: body.error } : {}),
      ...(typeof body.affectedCount === "number" ? { affectedCount: body.affectedCount } : {}),
    };
  }

  /**
   * 统一出口：拼 `_x.ai/hunk-tracker/` 前缀、带 sessionId、剥双层 result。
   * @returns undefined 表示方法不存在（能力记为 unavailable），调用方自行降级。
   */
  private async call<T>(name: string, params: Record<string, unknown>): Promise<T | undefined> {
    if (this.capability === "unavailable") return undefined;
    const sessionId = this.options.sessionId();
    if (!sessionId) throw new Error("当前没有活动会话，无法执行 hunk 操作");
    try {
      const raw = await this.client.request<unknown>(`_x.ai/hunk-tracker/${name}`, { sessionId, ...params });
      this.capability = "available";
      // 探针实录：响应是 { result: {...} }，业务载荷在里层。
      if (isRecord(raw) && isRecord(raw.result)) return raw.result as T;
      return (raw ?? {}) as T;
    } catch (error) {
      if (isMethodNotFound(error)) {
        this.capability = "unavailable";
        return undefined;
      }
      throw error;
    }
  }
}
