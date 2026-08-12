import { SETTING_SPECS, type SettingKey } from "../../../settings-messages";
import { Section, button, el, listItem } from "../components";
import type { PageDeps } from "../page-types";
import { settingRow } from "../setting-rows";

const CONFIG_GROUPS: readonly { title: string; keys: readonly SettingKey[] }[] = [
  { title: "配置来源", keys: ["managedGrokHome", "grokHome"] },
  { title: "快照存储", keys: ["snapshotRetentionDays", "snapshotMaxTotalMb"] },
];

/**
 * 隐私与安全。
 *
 * 这一页有三样东西是别处没有的：
 * - 已记住的权限规则，改造前只有一个「全部清空」命令、没有任何界面，
 *   于是「我到底授权过什么」这个问题在产品里根本无从回答。现在逐条列出可单独删。
 * - 运行画像，来自本次启动实际生成的配置与实际构造的子进程环境，不是固定文案。
 * - 托管目录与快照的存储上限。
 */
export function renderPrivacyPage(deps: PageDeps): HTMLElement[] {
  const nodes: HTMLElement[] = [];

  for (const group of CONFIG_GROUPS) {
    const section = new Section(group.title);
    for (const key of group.keys) {
      if (SETTING_SPECS[key].category !== "privacy") continue;
      section.add(settingRow(key, deps.settingRows));
    }
    if (!section.isEmpty) nodes.push(section.root);
  }

  nodes.push(renderPermissionRules(deps));
  nodes.push(...renderPrivacyProfile(deps));
  return nodes;
}

function renderPermissionRules(deps: PageDeps): HTMLElement {
  const rules = deps.state.permissionRules;
  const section = new Section(
    "已记住的权限规则",
    "你在权限卡片上选过「以后都允许」的操作。按当前工作区保存，换会话不会重新询问。",
  );

  for (const rule of rules) {
    section.add(listItem({
      title: rule.label,
      badges: [{ text: rule.kindLabel, tone: "muted" }],
      meta: [rule.value],
      actions: [
        button("删除", "danger", () => {
          deps.post({ type: "removePermissionRule", id: rule.id });
        }, { title: "删除后下次同类操作会重新询问" }),
      ],
    }));
  }
  section.empty("当前工作区还没有记住任何规则。每一次越权操作都会先问过你。");

  if (rules.length > 0) {
    const footer = el("div", "st-page-actions");
    footer.appendChild(button(`全部清空（${rules.length} 条）`, "danger", () => {
      deps.post({ type: "clearPermissionRules" });
    }));
    section.root.appendChild(footer);
  }
  return section.root;
}

function renderPrivacyProfile(deps: PageDeps): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  for (const view of deps.state.privacy) {
    const section = new Section(view.title);
    for (const kv of view.rows) {
      const line = el("div", "st-kv");
      line.appendChild(el("span", "st-kv-label", kv.label));
      line.appendChild(el("span", `st-kv-value${kv.tone ? ` ${kv.tone}` : ""}`, kv.value));
      section.add(line);
    }
    section.empty("暂无数据。");
    if (view.note) {
      section.root.appendChild(el("p", "st-section-desc", view.note));
    }
    nodes.push(section.root);
  }

  if (nodes.length > 0) {
    const actions = el("div", "st-page-actions");
    actions.appendChild(button("查看完整隐私文档", "default", () => {
      deps.post({ type: "openPrivacyStatus" });
    }, { title: "打开可复制的 Markdown 版本" }));
    actions.appendChild(button("Agent 诊断", "default", () => {
      deps.post({ type: "openDiagnostics" });
    }, { title: "Grok 实际读到了哪些规则文件" }));
    nodes.push(actions);
  }
  return nodes;
}
