import * as path from "node:path";

/**
 * Grok 可执行文件定位。
 * 设置里不再硬编码某台机器的绝对路径：留空时按「环境变量 → 自带 → PATH → 常见安装位置」
 * 探测，探测不到再引导用户手动选择一次并写回设置。
 *
 * 「自带」排在 PATH 前面是有意的：装了我们安装包的机器上，随包发出去的那份是配套测过的，
 * 不该被用户 PATH 里某个更早装的 grok 顶掉。用户真想用自己那份，填设置或环境变量即可。
 */

export interface GrokLocatorDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** 判断候选路径是否为可用文件。 */
  exists(candidate: string): boolean;
  /**
   * 随安装包一起发出去的 Grok 所在目录。开发态传空数组即可，
   * 生产由调用方从 `vscode.env.appRoot` 推导（见 bundledGrokRoots）。
   */
  bundledRoots?: readonly string[];
}

export type GrokSource = "setting" | "env" | "bundled" | "path" | "wellKnown";

export type GrokResolution =
  | { ok: true; executable: string; source: GrokSource }
  | { ok: false; reason: "configured-missing"; configured: string; candidates: string[] }
  | { ok: false; reason: "not-found"; candidates: string[] };

/** 显式指定 Grok 路径的环境变量，优先级高于自动探测。 */
export const GROK_EXECUTABLE_ENV = "LINGDONG_GROK_EXECUTABLE";

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

function executableNames(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== "win32") return ["grok"];
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith("."));
  const wanted = exts.filter((ext) => ext === ".exe" || ext === ".cmd" || ext === ".bat");
  return (wanted.length > 0 ? wanted : [".exe"]).map((ext) => `grok${ext}`);
}

function pathDirectories(deps: GrokLocatorDeps): string[] {
  const separator = deps.platform === "win32" ? ";" : ":";
  return (deps.env.PATH ?? deps.env.Path ?? "")
    .split(separator)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter((entry) => entry.length > 0);
}

/**
 * 从应用根目录推出自带 Grok 可能在的几个 `grok/bin`。
 *
 * 之所以是「往上找几层」而不是写死一条：安装布局不止一种。源码构建和 VSCodium 是
 * `<安装根>/resources/app`，而官方 Windows 包从 1.131 起在中间多插了一层 commit
 * 目录用于后台更新，变成 `<安装根>/<commit>/resources/app`。往上三层刚好把两种都覆盖，
 * 又不至于漫无边际地扫到安装目录之外。
 */
export function bundledGrokRoots(appRoot: string, platform: NodeJS.Platform): string[] {
  const p = pathApi(platform);
  const roots: string[] = [];
  let directory = appRoot;
  for (let level = 0; level <= 3; level += 1) {
    roots.push(p.join(directory, "grok", "bin"));
    const parent = p.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return roots;
}

/** 常见安装位置；只用于探测和错误提示，不代表一定存在。 */
export function wellKnownGrokPaths(deps: GrokLocatorDeps): string[] {
  const p = pathApi(deps.platform);
  const names = executableNames(deps.platform, deps.env);
  const roots: string[] = [];

  if (deps.platform === "win32") {
    const localAppData = deps.env.LOCALAPPDATA;
    const programFiles = deps.env.ProgramFiles;
    const userProfile = deps.env.USERPROFILE;
    if (localAppData) {
      roots.push(p.join(localAppData, "Programs", "grok", "bin"));
      roots.push(p.join(localAppData, "grok", "bin"));
    }
    if (programFiles) roots.push(p.join(programFiles, "grok", "bin"));
    if (userProfile) roots.push(p.join(userProfile, ".grok", "bin"));
  } else {
    const home = deps.env.HOME;
    roots.push("/usr/local/bin", "/opt/grok/bin", "/usr/bin");
    if (home) {
      roots.push(p.join(home, ".grok", "bin"));
      roots.push(p.join(home, ".local", "bin"));
    }
  }

  const result: string[] = [];
  for (const root of roots) {
    for (const name of names) result.push(p.join(root, name));
  }
  return result;
}

export function resolveGrokExecutable(configured: string, deps: GrokLocatorDeps): GrokResolution {
  const p = pathApi(deps.platform);
  const names = executableNames(deps.platform, deps.env);
  const bundled = (deps.bundledRoots ?? [])
    .flatMap((root) => names.map((name) => p.join(root, name)));
  const wellKnown = wellKnownGrokPaths(deps);
  // 找不到时列给用户看的候选：自带的排前面，那是装机后本该存在的位置。
  const candidates = [...bundled, ...wellKnown];

  const trimmed = configured.trim();
  if (trimmed) {
    if (deps.exists(trimmed)) return { ok: true, executable: trimmed, source: "setting" };
    return { ok: false, reason: "configured-missing", configured: trimmed, candidates };
  }

  const fromEnv = (deps.env[GROK_EXECUTABLE_ENV] ?? "").trim();
  if (fromEnv && deps.exists(fromEnv)) {
    return { ok: true, executable: fromEnv, source: "env" };
  }

  for (const candidate of bundled) {
    if (deps.exists(candidate)) return { ok: true, executable: candidate, source: "bundled" };
  }

  for (const directory of pathDirectories(deps)) {
    for (const name of names) {
      const candidate = p.join(directory, name);
      if (deps.exists(candidate)) return { ok: true, executable: candidate, source: "path" };
    }
  }

  for (const candidate of wellKnown) {
    if (deps.exists(candidate)) return { ok: true, executable: candidate, source: "wellKnown" };
  }

  return { ok: false, reason: "not-found", candidates };
}

/**
 * GROK_HOME：设置优先；留空时尝试可执行文件旁边的 data 目录，
 * 都没有就返回 undefined，交回给子进程继承的环境变量。
 *
 * 这里返回的是**探测到的原始** GROK_HOME。启用托管目录时，调用方会拿它作为播种源，
 * 真正交给子进程的是 ManagedGrokHome.directory。
 */
export function resolveGrokHome(
  configured: string,
  executable: string,
  deps: GrokLocatorDeps,
): string | undefined {
  const trimmed = configured.trim();
  if (trimmed) return trimmed;
  const p = pathApi(deps.platform);
  const sibling = p.resolve(p.dirname(executable), "..", "data");
  return deps.exists(sibling) ? sibling : undefined;
}

export function describeGrokResolution(resolution: GrokResolution): string {
  if (resolution.ok) return resolution.executable;
  const head = resolution.reason === "configured-missing"
    ? `设置中的 Grok 路径不存在：${resolution.configured}`
    : "未找到 Grok Build 可执行文件。已尝试环境变量、随包自带的位置、PATH 与常见安装位置。";
  return `${head}\n可在设置中填写 lingdongAgent.grokExecutable，或执行命令「灵动 Code: 选择 Grok 可执行文件」。`;
}
