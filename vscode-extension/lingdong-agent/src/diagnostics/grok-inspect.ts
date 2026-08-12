/**
 * 解析 `grok inspect --json`：Grok 自己报告它在当前目录发现了什么配置。
 *
 * 存在的理由：项目规则、技能、钩子、LSP、MCP 到底有没有被加载，此前只能靠猜。
 * 用户写了 AGENTS.md 却没生效时，我们连「Grok 有没有看见这个文件」都答不上来。
 * `inspect --json` 直接给出加载到的文件路径与近似 token 数，是唯一的权威答案。
 *
 * 字段名全部来自 0.2.118 的实际输出，没有臆造。未知字段一律忽略，
 * 上游加字段不该让诊断整体失败。
 */

/** 一个被 Grok 加载的项目指令文件。 */
export interface ProjectInstructionFile {
  path: string;
  /** `project` / `user` 等；上游未来可能扩展。 */
  scope: string;
  /** 实测出现过 `agents_md` 与 `rules`。 */
  fileType: string;
  sizeBytes: number;
  /** Grok 自己算的近似 token 数，用来判断规则是不是吃掉了太多上下文。 */
  approxTokens: number;
}

export interface NamedEntry {
  name: string;
  description?: string;
  /** 来源类型，例如 builtin / project / user。 */
  source?: string;
}

export interface ConfigLayer {
  role: string;
  path: string;
}

export interface GrokInspectReport {
  grokVersion?: string;
  channel?: string;
  cwd?: string;
  projectRoot?: string;
  projectTrusted?: boolean;
  projectInstructions: ProjectInstructionFile[];
  permissionsLoaded: number;
  hooks: NamedEntry[];
  skills: NamedEntry[];
  agents: NamedEntry[];
  plugins: NamedEntry[];
  mcpServers: NamedEntry[];
  lspServers: NamedEntry[];
  configLayers: ConfigLayer[];
  /** 开启了兼容读取的第三方 harness surface，例如 cursor/rules。 */
  externalCompat: { vendor: string; surface: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toNamed(value: unknown): NamedEntry | undefined {
  if (!isRecord(value)) return undefined;
  const name = str(value.name);
  if (!name) return undefined;
  // source 有时是 { type: "builtin" }，有时可能直接是字符串。
  const rawSource = value.source;
  const source = isRecord(rawSource) ? str(rawSource.type) : str(rawSource);
  return {
    name,
    ...(str(value.description) ? { description: str(value.description) as string } : {}),
    ...(source ? { source } : {}),
  };
}

function namedList(value: unknown): NamedEntry[] {
  return asArray(value)
    .map((item) => toNamed(item))
    .filter((item): item is NamedEntry => item !== undefined);
}

export function parseGrokInspect(raw: string): GrokInspectReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`grok inspect 输出不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("grok inspect 输出不是 JSON 对象");

  const permissions = isRecord(parsed.permissions) ? parsed.permissions : {};
  const configSources = isRecord(parsed.configSources) ? parsed.configSources : {};
  const externalCompat = isRecord(parsed.externalCompat) ? parsed.externalCompat : {};

  return {
    ...(str(parsed.grokVersion) ? { grokVersion: str(parsed.grokVersion) as string } : {}),
    ...(str(parsed.channel) ? { channel: str(parsed.channel) as string } : {}),
    ...(str(parsed.cwd) ? { cwd: str(parsed.cwd) as string } : {}),
    ...(str(parsed.projectRoot) ? { projectRoot: str(parsed.projectRoot) as string } : {}),
    ...(typeof parsed.projectTrusted === "boolean" ? { projectTrusted: parsed.projectTrusted } : {}),
    projectInstructions: asArray(parsed.projectInstructions)
      .filter(isRecord)
      .map((item) => ({
        path: str(item.path) ?? "",
        scope: str(item.scope) ?? "unknown",
        fileType: str(item.fileType) ?? "unknown",
        sizeBytes: num(item.sizeBytes),
        approxTokens: num(item.approxTokens),
      }))
      .filter((item) => item.path.length > 0),
    permissionsLoaded: num(permissions.loaded),
    hooks: namedList(parsed.hooks),
    skills: namedList(parsed.skills),
    agents: namedList(parsed.agents),
    plugins: namedList(parsed.plugins),
    mcpServers: namedList(parsed.mcpServers),
    lspServers: namedList(parsed.lspServers),
    configLayers: asArray(configSources.layers)
      .filter(isRecord)
      .map((item) => ({ role: str(item.role) ?? "unknown", path: str(item.path) ?? "" }))
      .filter((item) => item.path.length > 0),
    externalCompat: asArray(externalCompat.cells)
      .filter(isRecord)
      .filter((item) => item.enabled === true)
      .map((item) => ({ vendor: str(item.vendor) ?? "", surface: str(item.surface) ?? "" }))
      .filter((item) => item.vendor.length > 0 && item.surface.length > 0),
  };
}
