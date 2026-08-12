/**
 * 把 SETTING_SPECS 里的一条规格渲染成一行设置。
 *
 * 分类页因此不需要各自写死「这里放一个开关、那里放一个下拉」：
 * 规格表说它是什么类型，这里就渲染成什么控件。加一个设置只要往规格表里加一条，
 * 界面自动就有了，也不会漏掉说明文案。
 */

import {
  SETTING_KEYS,
  SETTING_SPECS,
  type SettingKey,
  type SettingValue,
  type SettingsCategory,
  type SettingsConfigView,
} from "../../settings-messages";
import {
  button,
  dropdown,
  el,
  radioCards,
  row,
  stepper,
  stringListEditor,
  textInput,
  toggle,
} from "./components";

export interface SettingRowDeps {
  config: SettingsConfigView;
  update(key: SettingKey, value: SettingValue): void;
  /** 只有 grokExecutable 用得到；给它一个「浏览…」按钮。 */
  pickExecutable(): void;
}

function currentValue(key: SettingKey, config: SettingsConfigView): SettingValue {
  const stored = config[key];
  return stored === undefined ? SETTING_SPECS[key].fallback : stored;
}

export function settingRow(key: SettingKey, deps: SettingRowDeps): HTMLElement {
  const spec = SETTING_SPECS[key];
  const value = currentValue(key, deps.config);
  const base = {
    title: spec.label,
    description: spec.description,
    ...(spec.detail ? { detail: spec.detail } : {}),
  };

  switch (spec.kind) {
    case "boolean":
      return row({
        ...base,
        control: toggle(value === true, (next) => deps.update(key, next), { label: spec.label }),
      });

    case "number": {
      const scale = spec.scale ?? 1;
      const shown = Math.round(Number(value) / scale);
      return row({
        ...base,
        control: stepper(
          shown,
          {
            min: Math.round(spec.min / scale),
            max: Math.round(spec.max / scale),
            step: Math.max(1, Math.round(spec.step / scale)),
            ...(spec.unit ? { unit: spec.unit } : {}),
          },
          (next) => deps.update(key, next * scale),
        ),
      });
    }

    case "select": {
      const options = spec.options;
      if (spec.display === "cards") {
        return row({
          ...base,
          block: radioCards(String(value), options, (next) => deps.update(key, next)),
        });
      }
      return row({
        ...base,
        control: dropdown(
          String(value),
          options.map((option) => ({ value: option.value, label: option.label })),
          (next) => deps.update(key, next),
        ),
      });
    }

    case "text": {
      const input = textInput(String(value), (next) => deps.update(key, next), {
        ...(spec.placeholder ? { placeholder: spec.placeholder } : {}),
      });
      if (key !== "grokExecutable") return row({ ...base, control: input });
      const group = el("div", "st-row-control");
      group.append(input, button("浏览…", "default", () => deps.pickExecutable()));
      return row({ ...base, control: group });
    }

    case "stringList":
      return row({
        ...base,
        block: stringListEditor(
          Array.isArray(value) ? value : [],
          (next) => deps.update(key, next),
          { ...(spec.placeholder ? { placeholder: spec.placeholder } : {}) },
        ),
      });
  }
}

/** 某个分类下的全部设置行，顺序即规格表里的声明顺序。 */
export function settingRowsFor(
  category: SettingsCategory,
  deps: SettingRowDeps,
): HTMLElement[] {
  return SETTING_KEYS
    .filter((key) => SETTING_SPECS[key].category === category)
    .map((key) => settingRow(key, deps));
}

/** 搜索命中判定：标题、说明、详细说明与键名都算。 */
export function settingMatches(key: SettingKey, query: string): boolean {
  if (!query) return true;
  const spec = SETTING_SPECS[key];
  const haystack = [key, spec.label, spec.description, spec.detail ?? ""].join(" ").toLowerCase();
  return haystack.includes(query.toLowerCase());
}
