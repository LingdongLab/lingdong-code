import type { ChangeKind, ChangedFile } from "./change-tracker";
import { normalizeRelativePath } from "./context-model";

/**
 * Diff 的纯逻辑：虚拟文档 URI、标题与左右两侧的选取。
 * 与 vscode 模块隔离，方便对中文、空格、井号等路径做单测。
 */

export const SNAPSHOT_SCHEME = "lingdong-snapshot";

export interface SnapshotUriParts {
  scheme: string;
  /** 只用于编辑器标签展示，真正的定位信息放在 query 里。 */
  path: string;
  query: string;
}

export interface SnapshotTarget {
  turnId: string;
  relativePath: string;
  /** 新建文件的左侧、删除文件的右侧都需要一个空文档。 */
  empty: boolean;
}

export function buildSnapshotUri(turnId: string, relativePath: string, empty = false): SnapshotUriParts {
  const normalized = normalizeRelativePath(relativePath);
  const query = new URLSearchParams({ turn: turnId, path: normalized, ...(empty ? { empty: "1" } : {}) });
  return { scheme: SNAPSHOT_SCHEME, path: `/${normalized}`, query: query.toString() };
}

export function parseSnapshotUri(parts: { query: string }): SnapshotTarget | undefined {
  const params = new URLSearchParams(parts.query);
  const turnId = params.get("turn");
  const relativePath = params.get("path");
  if (!turnId || !relativePath) return undefined;
  return { turnId, relativePath, empty: params.get("empty") === "1" };
}

const KIND_PREFIX: Record<ChangeKind, string> = {
  create: "新建",
  modify: "修改",
  delete: "删除",
  rename: "重命名",
};

export function diffTitle(input: {
  relativePath: string;
  turnIndex: number;
  kind: ChangeKind;
  previousRelativePath?: string;
}): string {
  const label = KIND_PREFIX[input.kind];
  const round = `第 ${input.turnIndex} 轮`;
  switch (input.kind) {
    case "create":
      // 新建不再左右对比（左侧全空没意义），标题也不再写「空 ↔」。
      return `${label} ${input.relativePath}（${round}）`;
    case "delete":
      return `${label} ${input.relativePath}（${round}：修改前）`;
    case "rename":
      return `${label} ${input.previousRelativePath ?? "?"} → ${input.relativePath}（${round}）`;
    default:
      return `${input.relativePath}（${round}：修改前 ↔ 当前）`;
  }
}

export type DiffSide =
  | { kind: "snapshot"; turnId: string; relativePath: string; empty: boolean }
  | { kind: "file"; absolutePath: string };

/**
 * - `diff`：修改 / 重命名，左右对照。
 * - `single`：新建（只看当前文件）或删除（只看修改前快照），避免一侧全空的斜纹废栏。
 */
export type DiffPlan =
  | { mode: "diff"; left: DiffSide; right: DiffSide; title: string }
  | { mode: "single"; side: DiffSide; title: string };

/**
 * 左侧固定是宿主自己保存的修改前快照，右侧是磁盘上的当前文件。
 * 新建 / 删除改走单栏，不再用空文档撑起半边 Diff。
 */
export function planDiff(change: ChangedFile, turnIndex: number): DiffPlan {
  const title = diffTitle({
    relativePath: change.relativePath,
    turnIndex,
    kind: change.kind,
    ...(change.previousRelativePath ? { previousRelativePath: change.previousRelativePath } : {}),
  });

  if (change.kind === "create") {
    return {
      mode: "single",
      side: { kind: "file", absolutePath: change.absolutePath },
      title,
    };
  }

  if (change.kind === "delete") {
    return {
      mode: "single",
      side: {
        kind: "snapshot",
        turnId: change.turnId,
        relativePath: change.relativePath,
        empty: false,
      },
      title,
    };
  }

  // 没有修改前快照时硬开左右 Diff，左侧只会是斜纹空栏——降级为单栏看当前文件。
  if (!change.restorable) {
    return {
      mode: "single",
      side: { kind: "file", absolutePath: change.absolutePath },
      title: `${change.relativePath}（第 ${turnIndex} 轮：当前文件）`,
    };
  }

  const snapshotPath = change.previousRelativePath ?? change.relativePath;
  return {
    mode: "diff",
    left: {
      kind: "snapshot",
      turnId: change.turnId,
      relativePath: snapshotPath,
      empty: false,
    },
    right: { kind: "file", absolutePath: change.absolutePath },
    title,
  };
}
