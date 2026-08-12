import type { AppElements, Post } from "../app-context";
import { element, emptyPanel } from "../dom-utils";
import {
  LEFT_DEFAULT_WIDTH,
  TOOL_META,
  clampLeftWidth,
  clampWorkbenchWidth,
  closeTool,
  closeWorkbench,
  openTool,
  suggestOpenTool,
  type WorkbenchState,
  type WorkbenchTool,
} from "../workbench-state";
import { renderHostToolPanel } from "./host-panel";

/**
 * 右侧动态工作台的外壳：标签、折叠、抽屉化与拖宽。
 * 面板内容由各 *-panel 模块渲染，这里只负责「打开哪个工具、多宽、要不要显示」。
 */

export const DRAWER_BREAKPOINT_PX = 1200;

export interface LayoutState {
  leftCollapsed?: boolean;
  leftPinned?: boolean;
  /** 左栏宽度（px），用户拖动后持久化。 */
  leftWidth?: number;
  workbench?: WorkbenchState;
}

export interface WorkbenchDeps {
  el: AppElements;
  post: Post;
  layout: LayoutState;
  /** 持久化到 vscode.setState。 */
  persist(layout: LayoutState): void;
  /** 某个工具需要重绘内容。 */
  renderTool(tool: WorkbenchTool): void;
  /** 工具被主动打开时的一次性副作用（例如向宿主拉取文件列表）。 */
  onActivate?(tool: WorkbenchTool): void;
}

export class WorkbenchView {
  private stateValue: WorkbenchState;
  private resizing = false;

  constructor(private readonly deps: WorkbenchDeps, initial: WorkbenchState) {
    this.stateValue = initial;
  }

  get state(): WorkbenchState { return this.stateValue; }
  get collapsed(): boolean {
    return this.stateValue.collapsed || this.stateValue.openTools.length === 0;
  }

  isOpen(tool: WorkbenchTool): boolean { return this.stateValue.openTools.includes(tool); }
  isActive(tool: WorkbenchTool): boolean { return this.stateValue.activeTool === tool; }

  save(): void {
    this.deps.layout.workbench = this.stateValue;
    this.deps.persist(this.deps.layout);
    this.applyChrome();
  }

  /** 左栏折叠、抽屉断点、宽度变量与激活面板一次性同步到 DOM。 */
  applyChrome(): void {
    const { el, layout } = this.deps;
    const collapsed = this.collapsed;
    el.shell.classList.toggle("left-collapsed", !!layout.leftCollapsed);
    el.shell.classList.toggle("left-pinned", !!layout.leftPinned);
    el.shell.classList.toggle("wb-collapsed", collapsed);
    el.shell.classList.toggle("wb-drawer", window.innerWidth < DRAWER_BREAKPOINT_PX && !collapsed);
    el.rightRail.hidden = collapsed;
    el.shell.style.setProperty(
      "--right-w",
      `${clampWorkbenchWidth(this.stateValue.width, window.innerWidth)}px`,
    );
    el.shell.style.setProperty(
      "--left-w",
      `${clampLeftWidth(layout.leftWidth ?? LEFT_DEFAULT_WIDTH, window.innerWidth)}px`,
    );
    const composer = document.querySelector(".composer") as HTMLElement | null;
    if (composer) {
      el.shell.style.setProperty("--composer-h", `${Math.max(composer.offsetHeight, 120)}px`);
    }
    this.renderTabs();
    for (const panel of Array.from(el.rightRail.querySelectorAll<HTMLElement>(".tab-panel"))) {
      panel.classList.toggle("active", !collapsed && panel.dataset.panel === this.stateValue.activeTool);
    }
  }

  private renderTabs(): void {
    const { el } = this.deps;
    el.wbTabs.replaceChildren();
    for (const tool of this.stateValue.openTools) {
      const meta = TOOL_META[tool];
      const tab = element("button", `wb-tab${this.isActive(tool) ? " active" : ""}`, meta.label);
      tab.type = "button";
      tab.dataset.tool = tool;
      if (!meta.enabled) {
        tab.disabled = true;
        tab.title = meta.note ?? "暂未配置";
      }
      const close = element("span", "wb-tab-close", "×");
      close.title = "关闭";
      tab.appendChild(close);
      tab.addEventListener("click", (event) => {
        const target = event.target;
        if (target === close || (target instanceof Node && close.contains(target))) {
          event.stopPropagation();
          this.close(tool);
          return;
        }
        this.activate(tool, true);
      });
      el.wbTabs.appendChild(tab);
    }
  }

  /** 打开并激活工具；Terminal / Browser 会转成宿主原生命令。 */
  activate(tool: WorkbenchTool, persist: boolean): void {
    const meta = TOOL_META[tool];
    if (!meta.enabled) return;
    if (meta.hostAction === "terminal") this.deps.post({ type: "openNativeTerminal" });
    else if (meta.hostAction === "browser") this.deps.post({ type: "openSimpleBrowser" });

    this.stateValue = openTool(this.stateValue, tool);
    if (persist) this.save();
    else this.applyChrome();
    this.paint(tool);
    this.deps.onActivate?.(tool);
  }

  open(tool: WorkbenchTool): void { this.activate(tool, true); }

  close(tool: WorkbenchTool): void {
    this.stateValue = closeTool(this.stateValue, tool);
    this.save();
    if (!this.collapsed && this.stateValue.activeTool) {
      this.activate(this.stateValue.activeTool, false);
    }
  }

  closeAll(): void {
    this.stateValue = closeWorkbench(this.stateValue);
    this.save();
  }

  toggle(): void {
    if (this.collapsed) this.open(this.stateValue.lastActiveTool ?? "changes");
    else this.closeAll();
  }

  /** 事件驱动的「建议打开」：用户手动关过就不再强开。 */
  suggest(tool: WorkbenchTool): void {
    const next = suggestOpenTool(this.stateValue, tool);
    if (next === this.stateValue) return;
    this.stateValue = next;
    this.save();
    if (!this.collapsed && this.stateValue.activeTool) {
      this.activate(this.stateValue.activeTool, false);
    }
  }

  /** 只有已打开的工具才需要重绘，避免无谓的 DOM 操作。 */
  refresh(tool: WorkbenchTool): void {
    if (!this.isOpen(tool)) return;
    this.paint(tool);
  }

  private paint(tool: WorkbenchTool): void {
    const { el, post } = this.deps;
    if (tool === "browser") {
      renderHostToolPanel(
        el.panelBrowser,
        "Browser",
        "已通过 VS Code Simple Browser / 系统浏览器打开。",
        "再次打开",
        () => post({ type: "openSimpleBrowser" }),
      );
      return;
    }
    if (tool === "terminal") {
      renderHostToolPanel(
        el.panelTerminal,
        "Terminal",
        "已调用 VS Code 原生终端。",
        "新建终端",
        () => post({ type: "openNativeTerminal" }),
      );
      return;
    }
    if (tool === "preview") {
      el.panelPreview.replaceChildren(emptyPanel("Preview", "暂未配置", true));
      return;
    }
    this.deps.renderTool(tool);
  }

  bindResize(): void {
    const { el } = this.deps;
    el.wbResize.addEventListener("mousedown", (event) => {
      event.preventDefault();
      this.resizing = true;
      document.body.style.cursor = "col-resize";
    });
    window.addEventListener("mousemove", (event) => {
      if (!this.resizing) return;
      const rect = el.shell.getBoundingClientRect();
      const width = rect.right - event.clientX;
      this.stateValue = {
        ...this.stateValue,
        width: clampWorkbenchWidth(width, window.innerWidth),
      };
      this.applyChrome();
    });
    window.addEventListener("mouseup", () => {
      if (!this.resizing) return;
      this.resizing = false;
      document.body.style.cursor = "";
      this.save();
    });
    window.addEventListener("resize", () => this.applyChrome());
    this.bindLeftResize();
  }

  /** 左栏拖宽：跟右栏同一套鼠标模式，宽度落在 layout 上持久化。 */
  private bindLeftResize(): void {
    const { el } = this.deps;
    let dragging = false;
    el.leftResize.addEventListener("mousedown", (event) => {
      event.preventDefault();
      dragging = true;
      el.leftResize.classList.add("dragging");
      document.body.style.cursor = "col-resize";
    });
    window.addEventListener("mousemove", (event) => {
      if (!dragging) return;
      const rect = el.shell.getBoundingClientRect();
      this.deps.layout.leftWidth = clampLeftWidth(event.clientX - rect.left, window.innerWidth);
      this.applyChrome();
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      el.leftResize.classList.remove("dragging");
      document.body.style.cursor = "";
      this.save();
    });
  }
}
