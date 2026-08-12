/**
 * 行级增删统计。
 *
 * 时间线上的 `+N -N` 一直是空的，理由写在 phase-7 报告里：没有可靠的 diff 数据源，
 * `turns.json` 只存路径与 SHA256，改前内容在快照目录、改后内容只在磁盘。
 * 现在 Grok 的编辑事件直接带来了前后全文（runtime 归一成 file_diff），
 * 数据源问题不存在了，只差一个算行数的函数。
 *
 * 「可靠」这条底线保留：算不动的时候返回 undefined，让调用方不显示，
 * 而不是给一个看起来精确其实是猜的数字。
 */

export interface LineDiffStat {
  added: number;
  deleted: number;
}

/**
 * LCS 的动态规划是 O(n*m)。给个格子数上限，超了就不算——
 * 一次编辑的行数统计不值得让 UI 线程停半秒。
 */
const MAX_DP_CELLS = 4_000_000;

/** 分行。末尾换行不算出一个空行，否则每个正常文件都会凭空多一行。 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * 统计从 oldText 到 newText 的新增/删除行数。
 *
 * 先剥掉首尾完全相同的行——真实编辑几乎都是在长文件中间动几行，
 * 剥完之后需要做 DP 的部分通常只剩十几行。
 */
export function countLineDiff(oldText: string, newText: string): LineDiffStat | undefined {
  const before = splitLines(oldText);
  const after = splitLines(newText);

  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;

  let tail = 0;
  while (
    tail < before.length - head
    && tail < after.length - head
    && before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }

  const oldRest = before.slice(head, before.length - tail);
  const newRest = after.slice(head, after.length - tail);

  if (oldRest.length === 0 || newRest.length === 0) {
    // 纯新增或纯删除，不需要 LCS。
    return { added: newRest.length, deleted: oldRest.length };
  }

  const common = longestCommonSubsequence(oldRest, newRest);
  if (common === undefined) return undefined;
  return { added: newRest.length - common, deleted: oldRest.length - common };
}

/** 滚动数组的 LCS 长度；超过格子上限返回 undefined。 */
function longestCommonSubsequence(a: readonly string[], b: readonly string[]): number | undefined {
  if (a.length * b.length > MAX_DP_CELLS) return undefined;
  let previous = new Int32Array(b.length + 1);
  let current = new Int32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    const left = a[i - 1];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = left === b[j - 1]
        ? (previous[j - 1] ?? 0) + 1
        : Math.max(previous[j] ?? 0, current[j - 1] ?? 0);
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }
  return previous[b.length];
}

/** 时间线条目上的 `+3 -1`；两边都是 0 时返回 undefined，不显示一个没信息量的角标。 */
export function describeLineDiff(stat: LineDiffStat | undefined): string | undefined {
  if (!stat) return undefined;
  if (stat.added === 0 && stat.deleted === 0) return undefined;
  return `+${stat.added} -${stat.deleted}`;
}
