import { Section } from "../components";
import type { PageDeps } from "../page-types";
import { settingRowsFor } from "../setting-rows";

/** 通用：窗口形态、编辑预览、推理原文、可执行文件路径。 */
export function renderGeneralPage(deps: PageDeps): HTMLElement[] {
  const section = new Section("界面与运行");
  for (const row of settingRowsFor("general", deps.settingRows)) section.add(row);
  return [section.root];
}
