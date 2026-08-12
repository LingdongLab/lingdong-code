/**
 * 行级差异，供会话流里的内联 diff 用。
 *
 * 为什么不直接塞整份前后文本给 Webview：一个文件几千行、一轮改十几个文件，
 * 全量传过去再在前端算，面板会明显卡一下。这里在宿主侧算好，只回传变更块。
 *
 * 算法是标准的 LCS 回溯。文件超过 MAX_LINES 就放弃精确差异（O(n·m) 的表会吃掉几百 MB），
 * 改成「整块替换」——内联预览本来就只是让人扫一眼，真要细看还有 VS Code 的 Diff 编辑器。
 */

export type DiffLineKind = "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 修改前的行号；新增行没有。 */
  oldLine?: number;
  /** 修改后的行号；删除行没有。 */
  newLine?: number;
}

export interface DiffHunk {
  /** 形如 `@@ -12,7 +12,9 @@`，与 unified diff 一致，便于人肉对照。 */
  header: string;
  lines: DiffLine[];
}

export interface DiffText {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** 超过行数上限时为 true：hunks 是降级结果，不是精确差异。 */
  degraded: boolean;
  /** 因为块数超限而被截掉的块数。 */
  omittedHunks: number;
}

/** 超过这个行数就不做精确 LCS：表大小按行数平方增长。 */
export const MAX_DIFF_LINES = 4_000;
/** 内联预览最多展示的块数，其余折进「还有 N 处改动」。 */
export const MAX_INLINE_HUNKS = 12;

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  // 末尾换行不算独立一行，否则每个文件都会多出一条空的上下文。
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type Op = { kind: DiffLineKind; text: string };

/** LCS 表回溯出的逐行操作序列。 */
function diffOps(before: readonly string[], after: readonly string[]): Op[] {
  const n = before.length;
  const m = after.length;
  // table[i][j] = before[i..] 与 after[j..] 的最长公共子序列长度
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const row = table[i] as number[];
      const next = table[i + 1] as number[];
      row[j] = before[i] === after[j]
        ? (next[j + 1] as number) + 1
        : Math.max(next[j] as number, row[j + 1] as number);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: "ctx", text: before[i] as string });
      i += 1;
      j += 1;
      continue;
    }
    const down = (table[i + 1] as number[])[j] as number;
    const right = (table[i] as number[])[j + 1] as number;
    if (down >= right) {
      ops.push({ kind: "del", text: before[i] as string });
      i += 1;
    } else {
      ops.push({ kind: "add", text: after[j] as string });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "del", text: before[i] as string });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "add", text: after[j] as string });
    j += 1;
  }
  return ops;
}

/** 整块替换：行数太多时的降级结果。 */
function wholeFileOps(before: readonly string[], after: readonly string[]): Op[] {
  return [
    ...before.map((text): Op => ({ kind: "del", text })),
    ...after.map((text): Op => ({ kind: "add", text })),
  ];
}

/** 把逐行操作切成带上下文的块，连续变更之间隔得够远才断开。 */
function toHunks(ops: readonly Op[], context: number): DiffHunk[] {
  const changed = ops.map((op) => op.kind !== "ctx");
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let index = 0; index < ops.length; index += 1) {
    if (!changed[index]) continue;
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length - 1, index + context);
    for (let k = from; k <= to; k += 1) keep[k] = true;
  }

  const hunks: DiffHunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let current: { lines: DiffLine[]; oldStart: number; newStart: number } | undefined;

  const flush = (): void => {
    if (!current) return;
    const oldCount = current.lines.filter((line) => line.kind !== "add").length;
    const newCount = current.lines.filter((line) => line.kind !== "del").length;
    hunks.push({
      header: `@@ -${current.oldStart},${oldCount} +${current.newStart},${newCount} @@`,
      lines: current.lines,
    });
    current = undefined;
  };

  ops.forEach((op, index) => {
    if (!keep[index]) {
      flush();
      if (op.kind !== "add") oldLine += 1;
      if (op.kind !== "del") newLine += 1;
      return;
    }
    current ??= { lines: [], oldStart: oldLine, newStart: newLine };
    current.lines.push({
      kind: op.kind,
      text: op.text,
      ...(op.kind === "add" ? {} : { oldLine }),
      ...(op.kind === "del" ? {} : { newLine }),
    });
    if (op.kind !== "add") oldLine += 1;
    if (op.kind !== "del") newLine += 1;
  });
  flush();
  return hunks;
}

export function computeDiffText(
  beforeText: string,
  afterText: string,
  options: { context?: number; maxHunks?: number } = {},
): DiffText {
  const context = options.context ?? 3;
  const maxHunks = options.maxHunks ?? MAX_INLINE_HUNKS;
  const before = splitLines(beforeText);
  const after = splitLines(afterText);

  const degraded = before.length + after.length > MAX_DIFF_LINES;
  const ops = degraded ? wholeFileOps(before, after) : diffOps(before, after);
  const all = toHunks(ops, context);
  const added = ops.filter((op) => op.kind === "add").length;
  const removed = ops.filter((op) => op.kind === "del").length;

  return {
    hunks: all.slice(0, maxHunks),
    added,
    removed,
    degraded,
    omittedHunks: Math.max(0, all.length - maxHunks),
  };
}
