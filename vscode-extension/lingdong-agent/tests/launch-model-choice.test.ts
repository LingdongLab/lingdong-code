import assert from "node:assert/strict";
import test from "node:test";
import { chooseLaunchModel, type LaunchModelSources } from "../src/services/runtime-bootstrap";

/**
 * 启动时「用哪个模型」的优先级。
 *
 * 这组用例的由来：会话记录与「最后一次选择」都按工作区存，
 * 换个文件夹当工作区两者同时归零，当时会直接掉回设置项默认值（内置 DeepSeek），
 * 于是新工作区里点新建对话必报「原来使用 DeepSeek，但凭据已不存在」——
 * 而用户配的是别家的 Key，从没选过 DeepSeek。
 */

const DEFAULT_MODEL = "deepseek-v4-flash";

function sources(patch: Partial<LaunchModelSources> = {}): LaunchModelSources {
  return {
    session: undefined,
    remembered: undefined,
    settingExplicit: undefined,
    usable: undefined,
    settingDefault: DEFAULT_MODEL,
    ...patch,
  };
}

test("新工作区里没有任何历史选择时，用注册表里能用的那个模型，而不是默认的 DeepSeek", () => {
  const chosen = chooseLaunchModel(sources({
    usable: { providerId: "qwen", modelId: "qwen3.7-flash" },
  }));

  assert.deepEqual(chosen, { providerId: "qwen", modelId: "qwen3.7-flash" });
});

test("会话记录优先于其它一切来源", () => {
  const chosen = chooseLaunchModel(sources({
    session: { providerId: "poe", modelId: "poe-gpt" },
    remembered: { providerId: "qwen", modelId: "qwen3.7-flash" },
    settingExplicit: "written-model",
    usable: { providerId: "other", modelId: "other-model" },
  }));

  assert.deepEqual(chosen, { providerId: "poe", modelId: "poe-gpt" });
});

test("没有会话记录时用上一次的界面选择，不被「能用的模型」抢走", () => {
  const chosen = chooseLaunchModel(sources({
    remembered: { providerId: "qwen", modelId: "qwen3.7-flash" },
    usable: { providerId: "other", modelId: "other-model" },
  }));

  assert.deepEqual(chosen, { providerId: "qwen", modelId: "qwen3.7-flash" });
});

test("用户手写进设置的模型压过自动挑选：那是明确表达过的意图", () => {
  const chosen = chooseLaunchModel(sources({
    settingExplicit: "written-model",
    usable: { providerId: "other", modelId: "other-model" },
  }));

  assert.deepEqual(chosen, { modelId: "written-model" });
});

test("一个凭据都没配时退回设置项默认值，好让缺 Key 的引导照常触发", () => {
  const chosen = chooseLaunchModel(sources());

  assert.deepEqual(chosen, { modelId: DEFAULT_MODEL });
});

test("会话记录没记 Provider 时原样透传，交给下游按模型 id 反查", () => {
  const chosen = chooseLaunchModel(sources({
    session: { modelId: "legacy-model" },
    usable: { providerId: "other", modelId: "other-model" },
  }));

  assert.deepEqual(chosen, { modelId: "legacy-model" });
});
