/**
 * Poe 积分余额的解析。
 *
 * 纯函数，不发请求也不落盘。之所以要按候选字段名容错：余额端点的响应结构
 * 只能以真实接口为准，离线无法确认字段名，而猜错一个键就会把「有余额」显示成
 * 「查不到」。所以这里按几个可能的键依次取第一个有限数值，全都落空就明确报解析失败——
 * **不回显原始响应**，那里面可能有账号信息。
 */

/**
 * 依次尝试的键名。首项是对着真实接口确认过的字段，其余是接口改名时的兜底。
 * 实测响应形如：
 * `{"current_point_balance":654141,"plan_points_balance":654141,"total_balance_usd":"19.82",...}`
 */
const BALANCE_KEYS: readonly string[] = [
  "current_point_balance",
  "plan_points_balance",
  "compute_points_available",
  "current_balance",
  "balance",
  "points",
];

/** 折算金额；接口给的是字符串。 */
const USD_KEYS: readonly string[] = ["total_balance_usd", "plan_balance_usd"];

export type BalanceParseResult =
  | { ok: true; points: number; label: string }
  | { ok: false; reason: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** 数字或纯数字字符串都接受；服务商用哪种写法都不该影响能不能显示。 */
function readNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || !/^-?\d+(\.\d+)?$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function findFirst(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = readNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function formatPoints(points: number): string {
  return Math.round(points).toLocaleString("en-US");
}

export function parsePoeBalance(body: string): BalanceParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: "余额接口返回的不是有效 JSON。" };
  }

  const record = asRecord(parsed);
  if (!record) return { ok: false, reason: "余额接口返回的结构无法识别。" };

  // 顶层找不到就往下看一层 data，OpenAI 风格的包装很常见。
  const nested = asRecord(record.data);
  const points = findFirst(record, BALANCE_KEYS)
    ?? (nested ? findFirst(nested, BALANCE_KEYS) : undefined);

  if (points === undefined) {
    return {
      ok: false,
      reason: "余额接口的响应里找不到可识别的积分字段，可能是接口结构有变。",
    };
  }

  const usd = findFirst(record, USD_KEYS) ?? (nested ? findFirst(nested, USD_KEYS) : undefined);
  const label = usd === undefined
    ? `当前剩余 ${formatPoints(points)} 积分`
    : `当前剩余 ${formatPoints(points)} 积分（约 $${usd.toFixed(2)}）`;
  return { ok: true, points, label };
}
