import type { AppState, Post } from "../app-context";
import { element, emptyPanel } from "../dom-utils";

/**
 * 右侧 Files 工具：只列相对路径，点击由宿主打开。
 *
 * 两点约束：
 * 1. 结果被截断时必须显式说明，否则用户会误以为工作区里只有这些文件。
 * 2. 列表刷新时复用同一个搜索框，避免边输入边重建导致光标丢失。
 */

export function truncationNotice(files: AppState["files"], shown: number): string | undefined {
  if (!files.truncated) return undefined;
  if (typeof files.matched === "number" && files.matched > shown) {
    return `匹配到 ${files.matched} 个文件，这里只显示前 ${shown} 个。请输入更精确的关键词缩小范围。`;
  }
  if (typeof files.scanLimit === "number") {
    return `工作区文件较多，仅扫描了前 ${files.scanLimit} 个，结果可能不完整。建议用关键词过滤。`;
  }
  return "结果已被截断，请用关键词缩小范围。";
}

export function renderFilesPanel(
  panel: HTMLElement,
  files: AppState["files"],
  post: Post,
  onQueryChange: (query: string) => void,
): void {
  let search = panel.querySelector<HTMLInputElement>(".files-search");
  let list = panel.querySelector<HTMLElement>(".files-list");

  if (!search || !list) {
    panel.replaceChildren();
    panel.appendChild(element("div", "panel-title", "Files"));
    const input = element("input", "session-search files-search");
    input.placeholder = "筛选文件…";
    input.addEventListener("input", () => onQueryChange(input.value));
    panel.appendChild(input);
    const box = element("div", "files-list");
    panel.appendChild(box);
    search = input;
    list = box;
  }
  // 正在输入时不要回写，否则光标会跳到末尾。
  if (document.activeElement !== search) search.value = files.query;

  list.replaceChildren();
  const notice = truncationNotice(files, files.items.length);
  if (notice) list.appendChild(element("div", "panel-banner warn", notice));

  if (files.items.length === 0) {
    list.appendChild(emptyPanel("无匹配文件", "打开工作区后将在此列出相对路径。", true));
    return;
  }
  for (const file of files.items) {
    const button = element("button", "session-item");
    button.type = "button";
    button.title = file.relativePath;
    button.appendChild(element("span", "session-title", file.relativePath));
    button.addEventListener("click", () => {
      post({ type: "openWorkspaceFile", relativePath: file.relativePath });
    });
    list.appendChild(button);
  }
}
