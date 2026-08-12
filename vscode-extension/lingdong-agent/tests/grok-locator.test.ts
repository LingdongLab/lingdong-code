import assert from "node:assert/strict";
import test from "node:test";
import {
  GROK_EXECUTABLE_ENV,
  bundledGrokRoots,
  describeGrokResolution,
  resolveGrokExecutable,
  resolveGrokHome,
  wellKnownGrokPaths,
  type GrokLocatorDeps,
} from "../src/grok-locator";

function deps(
  overrides: Partial<GrokLocatorDeps> & { files?: string[] } = {},
): GrokLocatorDeps {
  const files = new Set(overrides.files ?? []);
  return {
    platform: overrides.platform ?? "win32",
    env: overrides.env ?? {},
    exists: overrides.exists ?? ((candidate) => files.has(candidate)),
    ...(overrides.bundledRoots ? { bundledRoots: overrides.bundledRoots } : {}),
  };
}

test("设置里填了存在的路径就直接使用", () => {
  const resolution = resolveGrokExecutable("D:\\tools\\grok.exe", deps({
    files: ["D:\\tools\\grok.exe"],
  }));
  assert.deepEqual(resolution, {
    ok: true,
    executable: "D:\\tools\\grok.exe",
    source: "setting",
  });
});

test("设置里的路径不存在时不静默回退，明确报 configured-missing", () => {
  const resolution = resolveGrokExecutable("E:\\旧机器\\grok.exe", deps({
    files: ["C:\\Users\\me\\.grok\\bin\\grok.exe"],
    env: { USERPROFILE: "C:\\Users\\me" },
  }));
  assert.equal(resolution.ok, false);
  assert.equal(resolution.ok === false ? resolution.reason : undefined, "configured-missing");
  assert.match(describeGrokResolution(resolution), /E:\\旧机器\\grok\.exe/);
});

test("设置留空时优先读环境变量", () => {
  const resolution = resolveGrokExecutable("", deps({
    env: { [GROK_EXECUTABLE_ENV]: "D:\\grok\\grok.exe", PATH: "C:\\bin" },
    files: ["D:\\grok\\grok.exe", "C:\\bin\\grok.exe"],
  }));
  assert.equal(resolution.ok && resolution.source, "env");
  assert.equal(resolution.ok && resolution.executable, "D:\\grok\\grok.exe");
});

test("环境变量缺失时扫描 PATH（Windows 按 PATHEXT 补后缀）", () => {
  const resolution = resolveGrokExecutable("", deps({
    env: { PATH: "C:\\nope;C:\\bin", PATHEXT: ".COM;.EXE;.CMD" },
    files: ["C:\\bin\\grok.exe"],
  }));
  assert.equal(resolution.ok && resolution.source, "path");
  assert.equal(resolution.ok && resolution.executable, "C:\\bin\\grok.exe");
});

test("自带的 Grok 压过 PATH：装机版不该被用户机器上的旧版顶掉", () => {
  const resolution = resolveGrokExecutable("", deps({
    bundledRoots: ["C:\\Program Files\\Lingdong\\resources\\grok\\bin"],
    env: { PATH: "C:\\old" },
    files: ["C:\\Program Files\\Lingdong\\resources\\grok\\bin\\grok.exe", "C:\\old\\grok.exe"],
  }));
  assert.equal(resolution.ok && resolution.source, "bundled");
  assert.equal(
    resolution.ok && resolution.executable,
    "C:\\Program Files\\Lingdong\\resources\\grok\\bin\\grok.exe",
  );
});

test("自带的不存在时顺序不变，仍然落到 PATH", () => {
  const resolution = resolveGrokExecutable("", deps({
    bundledRoots: ["C:\\Program Files\\Lingdong\\resources\\grok\\bin"],
    env: { PATH: "C:\\bin" },
    files: ["C:\\bin\\grok.exe"],
  }));
  assert.equal(resolution.ok && resolution.source, "path");
});

test("显式指定过的仍然赢过自带：环境变量与设置都不被顶掉", () => {
  const bundledRoots = ["C:\\Program Files\\Lingdong\\resources\\grok\\bin"];
  const files = [
    "C:\\Program Files\\Lingdong\\resources\\grok\\bin\\grok.exe",
    "D:\\mine\\grok.exe",
  ];
  const fromEnv = resolveGrokExecutable("", deps({
    bundledRoots,
    env: { [GROK_EXECUTABLE_ENV]: "D:\\mine\\grok.exe" },
    files,
  }));
  assert.equal(fromEnv.ok && fromEnv.source, "env");

  const fromSetting = resolveGrokExecutable("D:\\mine\\grok.exe", deps({ bundledRoots, files }));
  assert.equal(fromSetting.ok && fromSetting.source, "setting");
});

test("bundledGrokRoots 同时覆盖扁平布局与带 commit 目录的官方布局", () => {
  const flat = bundledGrokRoots("C:\\Program Files\\Lingdong\\resources\\app", "win32");
  assert.ok(flat.includes("C:\\Program Files\\Lingdong\\resources\\grok\\bin"));
  assert.ok(flat.includes("C:\\Program Files\\Lingdong\\grok\\bin"));

  const versioned = bundledGrokRoots("C:\\Program Files\\Lingdong\\e4c7e7b1d6\\resources\\app", "win32");
  assert.ok(versioned.includes("C:\\Program Files\\Lingdong\\grok\\bin"));

  // 往上找是有限的：不该一路摸到盘符根上去。
  assert.ok(!flat.includes("C:\\grok\\bin"));
});

test("找不到时的候选清单会先列出自带位置", () => {
  const resolution = resolveGrokExecutable("", deps({
    bundledRoots: ["C:\\Program Files\\Lingdong\\resources\\grok\\bin"],
    env: { PATH: "C:\\nope" },
  }));
  assert.equal(resolution.ok, false);
  assert.equal(
    resolution.ok === false ? resolution.candidates[0] : undefined,
    "C:\\Program Files\\Lingdong\\resources\\grok\\bin\\grok.exe",
  );
  assert.match(describeGrokResolution(resolution), /自带/);
});

test("PATH 里没有时回退到常见安装位置", () => {
  const resolution = resolveGrokExecutable("", deps({
    env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", PATH: "C:\\nope" },
    files: ["C:\\Users\\me\\AppData\\Local\\Programs\\grok\\bin\\grok.exe"],
  }));
  assert.equal(resolution.ok && resolution.source, "wellKnown");
});

test("POSIX 平台使用无后缀名与 : 分隔的 PATH", () => {
  const resolution = resolveGrokExecutable("", deps({
    platform: "linux",
    env: { PATH: "/nope:/usr/local/bin", HOME: "/home/me" },
    files: ["/usr/local/bin/grok"],
  }));
  assert.equal(resolution.ok && resolution.executable, "/usr/local/bin/grok");

  const candidates = wellKnownGrokPaths(deps({ platform: "linux", env: { HOME: "/home/me" } }));
  assert.ok(candidates.includes("/home/me/.grok/bin/grok"));
  assert.ok(candidates.every((candidate) => !candidate.endsWith(".exe")));
});

test("彻底找不到时返回 not-found 并给出可操作提示", () => {
  const resolution = resolveGrokExecutable("", deps({ env: { PATH: "C:\\nope" } }));
  assert.equal(resolution.ok, false);
  assert.equal(resolution.ok === false ? resolution.reason : undefined, "not-found");
  assert.match(describeGrokResolution(resolution), /选择 Grok 可执行文件/);
});

test("GROK_HOME：设置优先，其次是可执行文件同级的 data 目录", () => {
  const withSetting = resolveGrokHome("D:\\custom\\data", "C:\\grok\\bin\\grok.exe", deps());
  assert.equal(withSetting, "D:\\custom\\data");

  const inferred = resolveGrokHome("", "C:\\grok\\bin\\grok.exe", deps({
    exists: (candidate) => candidate === "C:\\grok\\data",
  }));
  assert.equal(inferred, "C:\\grok\\data");

  const none = resolveGrokHome("", "C:\\grok\\bin\\grok.exe", deps());
  assert.equal(none, undefined);
});
