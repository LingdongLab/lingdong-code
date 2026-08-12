import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { ThinkingIndicator } from "../src/webview/thinking-indicator";

/** 手动推进的时钟与定时器，免得测试真的去等一秒。 */
function harness() {
  const dom = new JSDOM(
    "<!DOCTYPE html><div id=\"root\" hidden><span id=\"label\"></span><span id=\"elapsed\"></span></div>",
  );
  const document = dom.window.document;
  const el = {
    root: document.getElementById("root")!,
    label: document.getElementById("label")!,
    elapsed: document.getElementById("elapsed")!,
  };

  let clock = 1_000_000;
  const ticks: (() => void)[] = [];
  const indicator = new ThinkingIndicator({
    el,
    now: () => clock,
    setInterval: (handler) => {
      ticks.push(handler);
      return ticks.length;
    },
    clearInterval: (handle) => { ticks[(handle as number) - 1] = () => {}; },
  });

  return {
    el,
    indicator,
    /** 拨动时钟并触发一次心跳。 */
    advance(ms: number) {
      clock += ms;
      for (const tick of [...ticks]) tick();
    },
    timers: () => ticks.length,
  };
}

test("显示后按秒累计，首秒内不闪 0s", () => {
  const h = harness();
  h.indicator.show("思考中");

  assert.equal(h.el.root.hidden, false);
  assert.equal(h.el.label.textContent, "思考中");
  assert.equal(h.el.elapsed.textContent, "", "刚发出去就显示 0s 会很跳");

  h.advance(1000);
  assert.equal(h.el.elapsed.textContent, "1s");
  h.advance(36_000);
  assert.equal(h.el.elapsed.textContent, "37s", "实测 DeepSeek 能连想 37 秒");
});

test("换阶段只换标题，秒数继续累计", () => {
  const h = harness();
  h.indicator.show("思考中");
  h.advance(5000);
  assert.equal(h.el.elapsed.textContent, "5s");

  h.indicator.show("正在读取文件");
  assert.equal(h.el.label.textContent, "正在读取文件");
  assert.equal(h.el.elapsed.textContent, "5s", "用户关心的是这一轮总共等了多久，不该清零");

  h.advance(2000);
  assert.equal(h.el.elapsed.textContent, "7s");
});

test("重复的同一条文案不重启计时", () => {
  const h = harness();
  h.indicator.show("思考中");
  h.advance(3000);
  h.indicator.show("思考中");
  h.indicator.show("思考中");
  assert.equal(h.el.elapsed.textContent, "3s");
  assert.equal(h.timers(), 1, "不该每来一条就多挂一个定时器");
});

test("隐藏后清空并停表；再次显示从零开始", () => {
  const h = harness();
  h.indicator.show("思考中");
  h.advance(4000);
  h.indicator.hide();

  assert.equal(h.el.root.hidden, true);
  assert.equal(h.el.elapsed.textContent, "");
  assert.equal(h.indicator.visible, false);

  // 停表之后再走时间，不该再有人偷偷改 DOM。
  h.advance(10_000);
  assert.equal(h.el.elapsed.textContent, "");

  h.indicator.show("思考中");
  h.advance(1000);
  assert.equal(h.el.elapsed.textContent, "1s", "新一轮应当重新计时");
});

test("空文案兜底成「思考中」，不显示空白行", () => {
  const h = harness();
  h.indicator.show("   ");
  assert.equal(h.el.label.textContent, "思考中");
});

test("反复隐藏是安全的", () => {
  const h = harness();
  h.indicator.hide();
  h.indicator.hide();
  assert.equal(h.el.root.hidden, true);
  assert.equal(h.indicator.visible, false);
});
