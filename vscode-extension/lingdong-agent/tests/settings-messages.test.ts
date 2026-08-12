import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SETTINGS_CATEGORIES,
  SETTING_KEYS,
  SETTING_SPECS,
  coerceSettingValue,
  isExtensionsMessage,
  isModelSettingsMessage,
  parseSettingsMessage,
  permissionRuleId,
} from "../src/settings-messages";

/**
 * 统一设置页协议。
 *
 * 重点在两处：
 * - 规格表必须和 package.json 的 contributes.configuration 对得上。设置页现在是
 *   唯一入口，规格表里多一条就是一个改不动真实配置的假开关，少一条就是一个
 *   用户再也找不到的设置。
 * - 分段委派不能让任何一段的校验被绕过。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(path.join(here, "..", "package.json"), "utf8"),
) as { contributes: { configuration: { properties: Record<string, { type: string }> } } };

test("规格表里的每个键都真实存在于 package.json 的配置声明里", () => {
  const declared = manifest.contributes.configuration.properties;
  for (const key of SETTING_KEYS) {
    assert.ok(
      Object.hasOwn(declared, `lingdongAgent.${key}`),
      `${key} 在规格表里，但 package.json 没有声明它——界面上会是一个改不动真实配置的假开关`,
    );
  }
});

test("规格表声明的类型与 package.json 的类型一致", () => {
  const declared = manifest.contributes.configuration.properties;
  const expected: Record<string, string> = {
    boolean: "boolean",
    number: "number",
    text: "string",
    select: "string",
    stringList: "array",
  };
  for (const key of SETTING_KEYS) {
    const spec = SETTING_SPECS[key];
    assert.equal(
      declared[`lingdongAgent.${key}`]?.type,
      expected[spec.kind],
      `${key} 的类型两边对不上`,
    );
  }
});

test("每条规格都归到六个分类之一", () => {
  for (const key of SETTING_KEYS) {
    assert.ok(
      SETTINGS_CATEGORIES.includes(SETTING_SPECS[key].category),
      `${key} 的分类不在导航里，等于渲染不出来`,
    );
  }
});

test("除 model 外的 lingdongAgent.* 设置都进了规格表", () => {
  // model 由模型页写入，刻意不给自由文本框；除它以外漏掉任何一条都意味着
  // 用户在新设置页里再也找不到那个开关。
  const missing = Object.keys(manifest.contributes.configuration.properties)
    .map((full) => full.replace("lingdongAgent.", ""))
    .filter((key) => key !== "model" && !(SETTING_KEYS as string[]).includes(key));
  assert.deepEqual(missing, [], `这些设置在新页面上没有入口：${missing.join(", ")}`);
});

test("布尔值只收布尔，数字越界一律丢弃而不是夹住", () => {
  assert.equal(coerceSettingValue("memory", true), true);
  assert.equal(coerceSettingValue("memory", "true"), undefined);
  assert.equal(coerceSettingValue("snapshotRetentionDays", 30), 30);
  assert.equal(coerceSettingValue("snapshotRetentionDays", 0), undefined);
  assert.equal(coerceSettingValue("snapshotRetentionDays", 10_000), undefined);
});

test("枚举只收白名单内的取值", () => {
  assert.equal(coerceSettingValue("approvalPolicy", "yolo"), "yolo");
  assert.equal(coerceSettingValue("approvalPolicy", "YOLO"), undefined);
  assert.equal(coerceSettingValue("approvalPolicy", "anything"), undefined);
});

test("文本剔掉控制字符并去空白", () => {
  assert.equal(coerceSettingValue("grokHome", "  C:\\grok\u0007  "), "C:\\grok");
});

test("字符串列表去重、去空项，遇到非字符串整条丢弃", () => {
  assert.deepEqual(coerceSettingValue("webFetchDomains", ["x.ai", " ", "x.ai", "docs.rs"]), [
    "x.ai",
    "docs.rs",
  ]);
  assert.equal(coerceSettingValue("webFetchDomains", ["x.ai", 42]), undefined);
});

test("updateSetting 带未知键或非法值一律丢弃", () => {
  assert.equal(parseSettingsMessage({ type: "updateSetting", key: "nope", value: 1 }), undefined);
  assert.equal(
    parseSettingsMessage({ type: "updateSetting", key: "memory", value: "yes" }),
    undefined,
  );
  assert.deepEqual(parseSettingsMessage({ type: "updateSetting", key: "memory", value: false }), {
    type: "updateSetting",
    key: "memory",
    value: false,
  });
});

test("权限规则 id 必须是 kind\\0value 的形状", () => {
  const id = permissionRuleId("command-prefix", "npm test");
  assert.deepEqual(parseSettingsMessage({ type: "removePermissionRule", id }), {
    type: "removePermissionRule",
    id,
  });
  assert.equal(parseSettingsMessage({ type: "removePermissionRule", id: "npm test" }), undefined);
  assert.equal(parseSettingsMessage({ type: "removePermissionRule", id: "\u0000v" }), undefined);
  assert.equal(parseSettingsMessage({ type: "removePermissionRule", id: "k\u0000" }), undefined);
});

test("模型段与能力段的消息交回各自的校验，非法的照样被拦下", () => {
  const saveKey = parseSettingsMessage({ type: "saveKey", providerId: "poe", key: "sk-abc" });
  assert.ok(saveKey && isModelSettingsMessage(saveKey));
  // providerId 里带路径分隔符是模型段校验拦的，这里必须仍然拦得住。
  assert.equal(parseSettingsMessage({ type: "saveKey", providerId: "../x", key: "k" }), undefined);

  const skill = parseSettingsMessage({ type: "setSkillEnabled", name: "demo", enabled: true });
  assert.ok(skill && isExtensionsMessage(skill));
  assert.equal(parseSettingsMessage({ type: "setSkillEnabled", name: "", enabled: true }), undefined);
});

test("共有类型不落进任何一段，交给面板统一处理", () => {
  for (const type of ["ready", "refresh", "backToAgent"] as const) {
    const message = parseSettingsMessage({ type });
    assert.ok(message);
    assert.equal(isModelSettingsMessage(message), false, `${type} 不该被认成模型段消息`);
    assert.equal(isExtensionsMessage(message), false, `${type} 不该被认成能力段消息`);
  }
});

test("未知类型一律丢弃", () => {
  assert.equal(parseSettingsMessage({ type: "sendPrompt", text: "hi" }), undefined);
  assert.equal(parseSettingsMessage({ type: 42 }), undefined);
  assert.equal(parseSettingsMessage(null), undefined);
});
