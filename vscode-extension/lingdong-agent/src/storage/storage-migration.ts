/**
 * 存储结构版本与迁移登记表。
 * 每个仓库文件都带 schemaVersion；读到旧版本时逐级迁移，读到未来版本时拒绝并原样保留文件，
 * 避免新版本写过的数据被旧版本扩展改坏。
 */

export const SCHEMA_VERSION = 4;

export type StorageKind =
  | "session-index"
  | "session"
  | "transcript"
  | "turns"
  | "plans"
  | "providers"
  | "catalog"
  | "permissions"
  | "mcp-servers"
  | "skills-prefs"
  | "lsp-prefs";

export type Migration = (data: unknown) => unknown;

/** key 是源版本号：MIGRATIONS[kind][1] 负责把 v1 升到 v2。 */
export type MigrationRegistry = Partial<Record<StorageKind, Record<number, Migration>>>;

/** 结构未变的 kind 也必须登记，否则 migrateDocument 会判定缺少迁移并丢掉整份数据。 */
const identity: Migration = (data) => data;

/**
 * v2 → v3：session 新增 providerId。
 *
 * 旧会话只记了 modelId，而模型现在归属到 Provider。唯一能确定归属的是
 * 当前已经在跑的 deepseek-v4-flash，其余 modelId 一律留空，由恢复流程提示
 * 用户重新配置——猜一个 providerId 等于静默替换 Provider，是本阶段禁止的行为。
 */
const sessionV2ToV3: Migration = (data) => {
  if (typeof data !== "object" || data === null) return data;
  const record = data as Record<string, unknown>;
  if (typeof record.providerId === "string" && record.providerId !== "") return data;
  if (record.modelId !== "deepseek-v4-flash") return data;
  return { ...record, providerId: "deepseek" };
};

/**
 * v1 → v2：transcript 新增 timeline 条目类型。
 * 旧文件里没有该条目，数据本身无需改写；恢复时缺少时间线的旧轮次
 * 继续由旧版工具摘要回退渲染，不伪造统计。
 */
/**
 * v3 → v4：session 新增 workspaceRoot。
 *
 * 旧记录里只有 workspaceId（路径的 sha1），无法反查出路径，所以这里不能凭空造一个。
 * 留空即可：SessionRepository 读取时用自己已知的工作区根补齐，下一次 patch 顺带落盘。
 */
export const MIGRATIONS: MigrationRegistry = {
  "session-index": { 1: identity, 2: identity, 3: identity },
  session: { 1: identity, 2: sessionV2ToV3, 3: identity },
  transcript: { 1: identity, 2: identity, 3: identity },
  turns: { 1: identity, 2: identity, 3: identity },
  plans: { 1: identity, 2: identity, 3: identity },
  // v3 才引入的 kind；登记更早的级别只为容忍手工降级过的文件。
  providers: { 1: identity, 2: identity, 3: identity },
  // 模型目录缓存，同样是 v3 之后才有的；内容可随时重新拉取，无需真正的迁移逻辑。
  catalog: { 1: identity, 2: identity, 3: identity },
  // 「以后都允许」规则；读不出来时退化为「一条都没记住」，重新问一次即可，无需真正的迁移。
  permissions: { 1: identity, 2: identity, 3: identity },
  // 用户自定义 MCP / Skills 偏好；结构简单，身份迁移即可。
  "mcp-servers": { 1: identity, 2: identity, 3: identity },
  "skills-prefs": { 1: identity, 2: identity, 3: identity },
  // language server 预置的禁用列表；丢了就退回「全部启用」，重新探测即可。
  "lsp-prefs": { 1: identity, 2: identity, 3: identity },
};

export type MigrationResult =
  | { ok: true; data: unknown; migrated: boolean }
  | { ok: false; reason: "unsupported_version" | "missing_migration"; detail: string };

export function migrateDocument(
  kind: StorageKind,
  fromVersion: number,
  data: unknown,
  registry: MigrationRegistry = MIGRATIONS,
  targetVersion: number = SCHEMA_VERSION,
): MigrationResult {
  if (!Number.isInteger(fromVersion) || fromVersion < 1) {
    return { ok: false, reason: "unsupported_version", detail: `无法识别的 schemaVersion：${String(fromVersion)}` };
  }
  if (fromVersion > targetVersion) {
    return {
      ok: false,
      reason: "unsupported_version",
      detail: `数据版本 ${fromVersion} 高于当前支持的 ${targetVersion}，已跳过读取以免覆盖新版本数据。`,
    };
  }
  if (fromVersion === targetVersion) return { ok: true, data, migrated: false };

  let current = data;
  for (let version = fromVersion; version < targetVersion; version += 1) {
    const step = registry[kind]?.[version];
    if (!step) {
      return { ok: false, reason: "missing_migration", detail: `缺少 ${kind} 从 v${version} 到 v${version + 1} 的迁移。` };
    }
    current = step(current);
  }
  return { ok: true, data: current, migrated: true };
}
