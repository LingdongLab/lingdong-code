export type CompactCapability = "available" | "unavailable" | "unknown";

export interface CompactClient {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/** compact 相关 RPC 方法名，按优先级依次探测。 */
const COMPACT_METHOD_CANDIDATES = [
  "compact_conversation",
  "_x.ai/compact_conversation",
  "session/compact",
] as const;

/** initialize 返回的 agentCapabilities 中可能声明 compact 能力的键名。 */
const COMPACT_CAPABILITY_KEYS = [
  "compact_conversation",
  "_x.ai/compact_conversation",
  "session/compact",
  "compact",
] as const;

function isMethodNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\b-32601\b/.test(error.message) || /method not found/i.test(error.message);
}

function capabilityDeclared(agentCapabilities: Record<string, unknown>): boolean {
  for (const key of COMPACT_CAPABILITY_KEYS) {
    const value = agentCapabilities[key];
    if (value !== undefined && value !== false) return true;
  }
  return false;
}

/**
 * Grok Build 扩展能力适配：探测并调用 compact_conversation，
 * 不向会话发送 /compact 文本 prompt。
 */
export class GrokBuildAdapter {
  private capability: CompactCapability = "unknown";
  private resolvedMethod: string | undefined;

  constructor(
    private readonly client: CompactClient,
    private readonly options?: { sessionId?: () => string | undefined },
  ) {}

  get compactCapability(): CompactCapability {
    return this.capability;
  }

  /** 从 initialize 的 agentCapabilities 探测是否声明了 compact 相关方法。 */
  discoverCapabilities(agentCapabilities: Record<string, unknown> | undefined): void {
    if (!agentCapabilities) return;
    if (capabilityDeclared(agentCapabilities)) {
      this.capability = "available";
    }
  }

  /** 实测调用 compact_conversation；-32601 记 unavailable；成功记 available。 */
  async probeCompact(): Promise<CompactCapability> {
    const sessionId = this.options?.sessionId?.();
    const baseParams = sessionId ? { sessionId } : {};

    for (const method of COMPACT_METHOD_CANDIDATES) {
      try {
        await this.client.request(method, baseParams);
        this.capability = "available";
        this.resolvedMethod = method;
        return "available";
      } catch (error) {
        if (isMethodNotFound(error)) continue;
        throw error;
      }
    }

    this.capability = "unavailable";
    this.resolvedMethod = undefined;
    return "unavailable";
  }

  /** 正式手动压缩；capability=unavailable 时抛错，绝不发 /compact 文本 prompt。 */
  async compactConversation(context?: string): Promise<void> {
    if (this.capability === "unavailable") {
      throw new Error("当前 Grok 不支持 compact_conversation");
    }

    const method = this.resolvedMethod ?? COMPACT_METHOD_CANDIDATES[0];
    const params: Record<string, unknown> = {};
    const sessionId = this.options?.sessionId?.();
    if (sessionId) params.sessionId = sessionId;
    if (context !== undefined) params.context = context;

    await this.client.request(method, params);
    this.capability = "available";
    this.resolvedMethod = method;
  }
}
