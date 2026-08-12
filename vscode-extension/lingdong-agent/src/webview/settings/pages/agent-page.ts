import { SETTING_SPECS, type SettingKey } from "../../../settings-messages";
import { Section } from "../components";
import type { PageDeps } from "../page-types";
import { settingRow } from "../setting-rows";

/**
 * Agent 行为：审批、校验、计划节奏、联网。
 *
 * 这一页刻意分成三组而不是一长条：审批力度决定「会不会问你」，
 * 收尾行为决定「一轮做多少」，联网决定「能不能出网」——
 * 三件事互不相干，混在一张卡里扫起来找不到边界。
 */
const GROUPS: readonly { title: string; keys: readonly SettingKey[] }[] = [
  { title: "审批", keys: ["approvalPolicy", "permissionTimeoutMs"] },
  { title: "收尾与节奏", keys: ["verifyAfterEdit", "planStepGating"] },
  { title: "联网", keys: ["webFetch", "webFetchDomains"] },
];

export function renderAgentPage(deps: PageDeps): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  for (const group of GROUPS) {
    const section = new Section(group.title);
    for (const key of group.keys) {
      if (SETTING_SPECS[key].category !== "agent") continue;
      section.add(settingRow(key, deps.settingRows));
    }
    if (!section.isEmpty) nodes.push(section.root);
  }
  return nodes;
}
