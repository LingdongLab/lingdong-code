import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import {
  Section,
  listItem,
  radioCards,
  row,
  stepper,
  stringListEditor,
  textInput,
  toggle,
} from "../src/webview/settings/components";

/**
 * 设置页基础控件。
 *
 * 存在这一层的理由就是「同一个开关在每一页长得一样」，所以这里断言的是行为契约：
 * 提交时机、边界收敛、不触发多余写入。控件本身出问题会同时污染六个分类页。
 */

function installDom(): void {
  const dom = new JSDOM("<!DOCTYPE html><body></body>");
  const { window } = dom;
  for (const [key, value] of Object.entries({
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    KeyboardEvent: window.KeyboardEvent,
    Event: window.Event,
    Node: window.Node,
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
}

function fire(node: Element, type: string): void {
  node.dispatchEvent(new (globalThis as unknown as { Event: typeof Event }).Event(type));
}

function enter(node: Element): void {
  node.dispatchEvent(
    new (globalThis as unknown as { KeyboardEvent: typeof KeyboardEvent })
      .KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
}

test.beforeEach(installDom);

test("开关反映当前值，切换只上报一次", () => {
  const seen: boolean[] = [];
  const node = toggle(true, (next) => seen.push(next));
  const input = node.querySelector("input") as HTMLInputElement;
  assert.equal(input.checked, true);
  input.checked = false;
  fire(input, "change");
  assert.deepEqual(seen, [false]);
});

test("禁用的开关既点不动也标了样式", () => {
  const node = toggle(false, () => assert.fail("禁用状态不该产生写入"), { disabled: true });
  assert.ok(node.className.includes("disabled"));
  assert.equal((node.querySelector("input") as HTMLInputElement).disabled, true);
});

test("文本框只在失焦时提交，且值没变就不提交", () => {
  const seen: string[] = [];
  const input = textInput("old", (next) => seen.push(next));
  fire(input, "blur");
  assert.deepEqual(seen, [], "没改就提交会造成一次无意义的配置写入");

  input.value = "new";
  fire(input, "blur");
  assert.deepEqual(seen, ["new"]);
});

test("步进器按步长增减，并把越界值收回边界", () => {
  const seen: number[] = [];
  const node = stepper(10, { min: 1, max: 20, step: 5 }, (next) => seen.push(next));
  const buttons = [...node.querySelectorAll("button")];
  const input = node.querySelector("input") as HTMLInputElement;

  buttons[1]?.click();
  assert.deepEqual(seen, [15]);

  input.value = "9999";
  fire(input, "blur");
  assert.equal(seen.at(-1), 20);

  input.value = "-5";
  fire(input, "blur");
  assert.equal(seen.at(-1), 1);
});

test("步进器到边界时对应按钮禁用", () => {
  const atMin = stepper(1, { min: 1, max: 20, step: 1 }, () => undefined);
  assert.equal([...atMin.querySelectorAll("button")][0]?.disabled, true);

  const atMax = stepper(20, { min: 1, max: 20, step: 1 }, () => undefined);
  assert.equal([...atMax.querySelectorAll("button")][1]?.disabled, true);
});

test("步进器里输入非数字时回退到原值，不写一个 NaN 进去", () => {
  const seen: number[] = [];
  const node = stepper(7, { min: 1, max: 20, step: 1 }, (next) => seen.push(next));
  const input = node.querySelector("input") as HTMLInputElement;
  input.value = "abc";
  fire(input, "blur");
  assert.deepEqual(seen, []);
  assert.equal(input.value, "7");
});

test("单选卡标出当前项，点当前项不重复上报", () => {
  const seen: string[] = [];
  const node = radioCards("b", [
    { value: "a", label: "甲" },
    { value: "b", label: "乙", description: "说明" },
  ], (next) => seen.push(next));

  const cards = [...node.querySelectorAll<HTMLButtonElement>(".st-choice")];
  assert.equal(cards[1]?.getAttribute("aria-checked"), "true");
  assert.equal(cards[0]?.getAttribute("aria-checked"), "false");
  assert.ok(cards[1]?.textContent?.includes("说明"));

  cards[1]?.click();
  assert.deepEqual(seen, []);
  cards[0]?.click();
  assert.deepEqual(seen, ["a"]);
});

test("列表编辑器删项、加项，空项与重复项都不入列", () => {
  const seen: string[][] = [];
  const node = stringListEditor(["a", "b"], (next) => seen.push(next));

  (node.querySelectorAll<HTMLButtonElement>(".st-chip-remove")[0])?.click();
  assert.deepEqual(seen.at(-1), ["b"]);

  const input = node.querySelector("input") as HTMLInputElement;
  input.value = "  ";
  enter(input);
  assert.equal(seen.length, 1, "空白不该新增一条");

  input.value = "a";
  enter(input);
  assert.equal(seen.length, 1, "已有的值不该重复加");

  input.value = "c";
  enter(input);
  assert.deepEqual(seen.at(-1), ["a", "b", "c"]);
});

test("空列表显式画一个「（空）」，不留一片看不出状态的空白", () => {
  const node = stringListEditor([], () => undefined);
  assert.ok(node.querySelector(".st-list-empty"));
});

test("设置行把控件放右边，长说明折叠", () => {
  const node = row({
    title: "标题",
    description: "一句话",
    detail: "一大段背景",
    control: toggle(false, () => undefined),
  });
  assert.equal(node.querySelector(".st-row-title")?.textContent, "标题");
  assert.equal(node.querySelector(".st-row-desc")?.textContent, "一句话");
  assert.ok(node.querySelector(".st-row-control .st-toggle"));
  const fold = node.querySelector<HTMLDetailsElement>("details.st-row-detail");
  assert.ok(fold);
  assert.equal(fold.open, false);
});

test("整行铺开的控件落在 block 区而不是右侧", () => {
  const node = row({ title: "标题", block: radioCards("a", [
    { value: "a", label: "甲" },
    { value: "b", label: "乙" },
  ], () => undefined) });
  assert.ok(node.querySelector(".st-row-block .st-cards"));
  assert.equal(node.querySelector(".st-row-control"), null);
});

test("分组为空时给一句话而不是一个空壳", () => {
  const section = new Section("标题");
  assert.equal(section.isEmpty, true);
  section.empty("这里还没有东西。");
  assert.equal(section.root.querySelector(".st-empty")?.textContent, "这里还没有东西。");

  const filled = new Section("标题");
  filled.add(row({ title: "一行" }));
  filled.empty("不该出现");
  assert.equal(filled.root.querySelector(".st-empty"), null);
});

test("列表条目按顺序摆徽标与多行说明，空说明不占一行", () => {
  const node = listItem({
    title: "某项",
    badges: [{ text: "项目" }, { text: "已就绪", tone: "ok" }],
    meta: ["第一行", "", "第三行"],
  });
  assert.deepEqual(
    [...node.querySelectorAll(".st-badge")].map((n) => n.textContent),
    ["项目", "已就绪"],
  );
  assert.deepEqual(
    [...node.querySelectorAll(".st-item-meta")].map((n) => n.textContent),
    ["第一行", "第三行"],
  );
});

test("样式表只有一份，且六个分类共用同一批类名", () => {
  // 改造前是 ms-* 与 ex-* 两套互不知道对方存在的样式；退回那个状态的第一步
  // 就是有人又新建一个前缀，所以这里把「只有一份」钉住。
  const here = path.dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(
    path.join(here, "..", "src", "webview", "settings", "settings.css"),
    "utf8",
  );
  for (const required of [".st-row", ".st-toggle", ".st-select", ".st-stepper", ".st-choice", ".st-card"]) {
    assert.ok(css.includes(required), `settings.css 缺少 ${required}`);
  }
  assert.equal(css.includes(".ms-"), false, "模型页不该再带自己的一套前缀");
  assert.equal(css.includes(".ex-"), false, "能力页不该再带自己的一套前缀");
});
