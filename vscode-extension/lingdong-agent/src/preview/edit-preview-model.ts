/**
 * 编辑预览的决策逻辑（纯函数，可脱离 VS Code 单测）。
 *
 * 要解决的差距：Cursor 在 Agent 落笔的同时就把 diff 摆在编辑器里，而我们此前只有
 * 事后「变更」面板的快照对比——一整轮结束才看得见改了什么。
 *
 * 唯一可靠的信息源是 Grok 在工具事件里给出的 `diff` content 项（前后全文），
 * 由 runtime 归一成 file_diff。刻意不去猜半截 JSON 参数里的 new_string：
 * 参数流是不完整的 JSON，拼错一次就会把用户的文件显示成一团乱码。
 */

export type EditPreviewMode = "diff" | "reveal" | "off";

export const EDIT_PREVIEW_SCHEME = "lingdong-edit-preview";

/** 预览编辑器的一侧；before 永远是虚拟文档，after 落盘后可以指向真实文件。 */
export type PreviewSide = "before" | "after";

export interface PreviewUriParts {
  scheme: string;
  /** 用真实路径做 path，编辑器标题栏才显示得出文件名。 */
  path: string;
  query: string;
}

export function buildPreviewUri(file: string, side: PreviewSide, revision: number): PreviewUriParts {
  const params = new URLSearchParams({ file, side, rev: String(revision) });
  return {
    scheme: EDIT_PREVIEW_SCHEME,
    // 前导斜杠是 URI 的要求；Windows 路径里的反斜杠留着，parse 时原样取回。
    path: `/${file.replace(/^[/\\]+/, "")}`,
    query: params.toString(),
  };
}

export interface ParsedPreviewUri {
  file: string;
  side: PreviewSide;
  revision: number;
}

export function parsePreviewUri(query: string): ParsedPreviewUri | undefined {
  const params = new URLSearchParams(query);
  const file = params.get("file");
  const side = params.get("side");
  if (!file || (side !== "before" && side !== "after")) return undefined;
  const revision = Number.parseInt(params.get("rev") ?? "0", 10);
  return { file, side, revision: Number.isFinite(revision) ? revision : 0 };
}

export interface EditPreviewDiff {
  toolCallId: string;
  file: string;
  change: "create" | "modify" | "delete";
  oldText: string;
  newText: string;
  /** true 表示工具还没收尾，磁盘上大概率还是旧内容。 */
  pending: boolean;
}

/** 打开一个并排 diff。 */
export interface DiffAction {
  kind: "diff";
  file: string;
  title: string;
  revision: number;
  /** 右侧指向真实文件（已落盘）还是虚拟文档（还在写）。 */
  rightIsFile: boolean;
}

/** 只把文件揭示出来（预览关成 reveal，或者文本太大不值得做 diff）。 */
export interface RevealAction {
  kind: "reveal";
  file: string;
}

export type EditPreviewAction = DiffAction | RevealAction | { kind: "none" };

const NONE: EditPreviewAction = { kind: "none" };

export interface EditPreviewPlannerDeps {
  mode: () => EditPreviewMode;
  /**
   * 是否允许预览这个路径。只放行活动仓库内的文件：
   * Agent 可能读写临时目录或用户主目录里的东西，把那些也弹到编辑器里是骚扰。
   */
  allow: (file: string) => boolean;
  /** 前后全文合计超过这个字节数就退化成 reveal，避免大文件 diff 卡住 UI。 */
  maxBytes?: number;
}

interface FileState {
  revision: number;
  before: string;
  after: string;
  /** 已经因为这个文件开过 diff，重复内容不再重开。 */
  shown: boolean;
}

const DEFAULT_MAX_BYTES = 512 * 1024;

/**
 * 预览状态机。一轮一个实例的生命周期由宿主控制（换轮清空）。
 */
export class EditPreviewPlanner {
  private readonly files = new Map<string, FileState>();
  /** 已经 reveal 过的 toolCallId，避免参数流每来一片都揭示一次。 */
  private readonly revealed = new Set<string>();

  constructor(private readonly deps: EditPreviewPlannerDeps) {}

  private get maxBytes(): number {
    return this.deps.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /**
   * 工具刚开始写参数、只知道目标路径时：先把文件揭示出来。
   * diff 要等 Grok 把前后全文送过来，在那之前至少让用户看见「它在动哪个文件」。
   */
  onEditTarget(toolCallId: string, kind: string, target: string | undefined): EditPreviewAction {
    if (this.deps.mode() === "off") return NONE;
    if (kind !== "edit") return NONE;
    const file = target?.trim();
    if (!file || !this.deps.allow(file)) return NONE;
    if (this.revealed.has(toolCallId)) return NONE;
    // 已经开过 diff 的文件不要再退回普通编辑器，否则 diff 会被顶掉。
    if (this.files.get(file)?.shown) return NONE;
    this.revealed.add(toolCallId);
    return { kind: "reveal", file };
  }

  /** 拿到前后全文：这才是真正能画出 diff 的时刻。 */
  onDiff(input: EditPreviewDiff): EditPreviewAction {
    const mode = this.deps.mode();
    if (mode === "off") return NONE;
    if (!this.deps.allow(input.file)) return NONE;

    const previous = this.files.get(input.file);
    // 内容一模一样且已经展示过：重复的 update，不要再抢一次焦点。
    if (previous?.shown && previous.before === input.oldText && previous.after === input.newText) {
      return NONE;
    }

    const revision = (previous?.revision ?? 0) + 1;
    this.files.set(input.file, {
      revision,
      before: input.oldText,
      after: input.newText,
      shown: true,
    });

    if (mode === "reveal") {
      // 删除的文件揭示不出来，只能什么都不做。
      return input.change === "delete" ? NONE : { kind: "reveal", file: input.file };
    }
    const bytes = Buffer.byteLength(input.oldText, "utf8") + Buffer.byteLength(input.newText, "utf8");
    if (bytes > this.maxBytes) {
      return input.change === "delete" ? NONE : { kind: "reveal", file: input.file };
    }
    return {
      kind: "diff",
      file: input.file,
      title: diffTitle(input),
      revision,
      // 落盘后右侧直接用真实文件：用户可以就地继续改，而不是对着一份只读副本。
      rightIsFile: !input.pending && input.change !== "delete",
    };
  }

  /** 供内容提供器取文本；找不到时返回 undefined（编辑器会显示空文档）。 */
  content(file: string, side: PreviewSide): string | undefined {
    const state = this.files.get(file);
    if (!state) return undefined;
    return side === "before" ? state.before : state.after;
  }

  /** 已经预览过的文件数，用于日志与测试。 */
  get previewedFiles(): string[] {
    return [...this.files.keys()];
  }

  reset(): void {
    this.files.clear();
    this.revealed.clear();
  }
}

function diffTitle(input: EditPreviewDiff): string {
  const name = baseName(input.file);
  const verb = input.change === "create" ? "新建" : input.change === "delete" ? "删除" : "修改";
  return input.pending ? `${verb}中：${name}` : `已${verb}：${name}`;
}

function baseName(file: string): string {
  const parts = file.split(/[\\/]/);
  return parts[parts.length - 1] || file;
}
