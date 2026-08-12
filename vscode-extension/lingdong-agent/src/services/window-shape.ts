/**
 * 窗口形态：Agent 形态与 IDE 形态。
 *
 * Cursor 有两种窗口——IDE 窗口有活动栏和文件树，Agent 窗口只有对话。我们的基座
 * 是一整个工作台，天然就是 IDE 形态：打开文件夹后左边一列 VS Code 的文件树、
 * 中间又是我们自己的仓库树，两列在干同一件事，这是界面显得「一坨」的直接来源。
 *
 * 摆成 Agent 形态不需要改基座源码：
 * - 活动栏的 `workbench.activityBar.location` 有 `hidden` 这一档；
 * - 辅助栏有 `workbench.secondarySideBar.defaultVisibility`。
 *   这两项都是 WINDOW 作用域、也没有 disallowConfigurationDefault 标记，
 *   所以能直接由扩展的 contributes.configurationDefaults 声明成默认值。
 * - 主侧边栏没有对应的设置项，只有命令，所以这一步必须由代码做。
 *
 * 「回到默认值」用的是清掉用户覆盖（value: undefined）而不是写死 hidden：
 * 默认值已经由 configurationDefaults 给了，写死会在用户设置里留一条噪音，
 * 而且日后调默认值时改不动它。
 */

export type WindowShape = "agent" | "ide";

export const SHAPE_SETTING_KEY = "windowShape";
/** 默认 Agent 形态：隐藏 VS Code 活动栏/资源管理器；关掉主面板由 ensureHomePanel 自动开回，避免空白壳。 */
export const DEFAULT_SHAPE: WindowShape = "agent";

export function isWindowShape(value: unknown): value is WindowShape {
  return value === "agent" || value === "ide";
}

export function readShape(raw: unknown): WindowShape {
  return isWindowShape(raw) ? raw : DEFAULT_SHAPE;
}

export function otherShape(shape: WindowShape): WindowShape {
  return shape === "agent" ? "ide" : "agent";
}

/** 一步布局动作：要么执行工作台命令，要么改一条全局设置。 */
export type ShapeAction =
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "setting"; readonly key: string; readonly value: string | boolean | undefined };

/**
 * 摆成某个形态需要做的动作，按执行顺序。
 *
 * 先改设置再执行命令：活动栏是靠设置收起的，命令只负责主侧边栏，
 * 顺序反了会看到活动栏先闪一下再消失。
 */
export function shapeActions(shape: WindowShape): readonly ShapeAction[] {
  if (shape === "agent") {
    return [
      { kind: "setting", key: "workbench.activityBar.location", value: "hidden" },
      { kind: "setting", key: "workbench.secondarySideBar.defaultVisibility", value: "hidden" },
      // 藏掉「灵动 Code」标签条，让主面板顶到窗口上沿（Cursor 式）。
      { kind: "setting", key: "workbench.editor.showTabs", value: "none" },
      // 标题栏不要窗口标题文字，也不要拆分/关闭/⋯ 编辑器动作。
      { kind: "setting", key: "window.title", value: "" },
      { kind: "setting", key: "workbench.editor.editorActionsLocation", value: "hidden" },
      // 关掉标题栏中间 Command Center；菜单栏只留 File/Edit/View/Help（源码侧已裁剪）。
      { kind: "setting", key: "window.commandCenter", value: false },
      { kind: "setting", key: "window.menuBarVisibility", value: "classic" },
      { kind: "command", command: "workbench.action.closeSidebar" },
    ];
  }
  return [
    { kind: "setting", key: "workbench.activityBar.location", value: "default" },
    { kind: "setting", key: "workbench.editor.showTabs", value: "multiple" },
    { kind: "setting", key: "workbench.editor.editorActionsLocation", value: "default" },
    { kind: "setting", key: "window.commandCenter", value: false },
    { kind: "setting", key: "window.menuBarVisibility", value: "classic" },
    { kind: "command", command: "workbench.action.focusSideBar" },
  ];
}

export interface ShapeHost {
  executeCommand(command: string): PromiseLike<unknown>;
  /** value 为 undefined 表示删掉用户覆盖，让默认值重新生效。 */
  updateGlobalSetting(key: string, value: string | boolean | undefined): PromiseLike<void>;
  log(line: string): void;
}

/**
 * 逐步摆布局。
 *
 * 单步失败只记日志不抛：基座换版本时命令 id 或设置项都可能改名，
 * 摆不动布局是体验退化，不该连带把扩展激活拖垮。
 */
export async function applyWindowShape(shape: WindowShape, host: ShapeHost): Promise<void> {
  for (const action of shapeActions(shape)) {
    const label = action.kind === "setting" ? action.key : action.command;
    try {
      if (action.kind === "setting") await host.updateGlobalSetting(action.key, action.value);
      else await host.executeCommand(action.command);
    } catch (error) {
      host.log(`[shape] ${label} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  host.log(`[shape] 已摆成 ${shape === "agent" ? "Agent" : "IDE"} 形态`);
}
