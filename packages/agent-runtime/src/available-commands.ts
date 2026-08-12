/**
 * Grok 经 ACP 广告的斜杠命令面。
 *
 * 来源有两处，形状相同：
 * - `initialize` 的 `_meta.availableCommands`
 * - `session/update` 的 `available_commands_update`
 *
 * 以前整份丢掉，界面只能靠本地硬编码的拒绝表猜「能不能用」。
 * 接住这份清单之后，宿主才能把「终端专属」和「Agent 支持、尚未接 UI」分开，
 * 并对后者走 `session/prompt` 透传（探针已证明 Agent 侧会自己解析）。
 */

export interface AvailableCommand {
  name: string;
  description?: string;
  /** 参数提示，来自广告项的 `input.hint`。 */
  inputHint?: string;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseOne(raw: unknown): AvailableCommand | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const name = stringField(record, "name");
  if (!name) return undefined;
  const description = stringField(record, "description");
  const input = typeof record.input === "object" && record.input !== null && !Array.isArray(record.input)
    ? record.input as Record<string, unknown>
    : undefined;
  const inputHint = input ? stringField(input, "hint") : undefined;
  return {
    name,
    ...(description ? { description } : {}),
    ...(inputHint ? { inputHint } : {}),
  };
}

/**
 * 从任意载荷里抠命令列表。initialize._meta 与 available_commands_update
 * 都可能用 `availableCommands` 或 `commands` 这两个键。
 */
export function parseAvailableCommands(raw: unknown): AvailableCommand[] {
  if (Array.isArray(raw)) {
    return dedupe(raw.map(parseOne).filter((item): item is AvailableCommand => item !== undefined));
  }
  if (typeof raw !== "object" || raw === null) return [];
  const record = raw as Record<string, unknown>;
  const list = record.availableCommands ?? record.commands;
  return Array.isArray(list) ? parseAvailableCommands(list) : [];
}

/** 从 initialize 结果的 `_meta` 取命令面；没有就空数组。 */
export function commandsFromInitializeMeta(meta: unknown): AvailableCommand[] {
  if (typeof meta !== "object" || meta === null) return [];
  return parseAvailableCommands((meta as Record<string, unknown>).availableCommands);
}

function dedupe(commands: readonly AvailableCommand[]): AvailableCommand[] {
  const seen = new Set<string>();
  const out: AvailableCommand[] = [];
  for (const command of commands) {
    const key = command.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(command);
  }
  return out;
}

export function availableCommandNames(commands: readonly AvailableCommand[]): ReadonlySet<string> {
  return new Set(commands.map((command) => command.name.toLowerCase()));
}
