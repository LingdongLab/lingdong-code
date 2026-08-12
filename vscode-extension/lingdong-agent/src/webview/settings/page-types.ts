import type { SettingsWebviewMessage } from "../../settings-messages";
import type { SettingRowDeps } from "./setting-rows";
import type { PageState } from "./state";

/** 每个分类页拿到的东西：状态、发消息、请求重绘，以及设置行的依赖。 */
export interface PageDeps {
  state: PageState;
  post(message: SettingsWebviewMessage): void;
  repaint(): void;
  settingRows: SettingRowDeps;
  now: number;
}

export interface PageChrome {
  title: string;
  description?: string;
  actions?: HTMLElement[];
}
