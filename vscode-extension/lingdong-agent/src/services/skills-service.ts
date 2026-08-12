import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { FileSystemPort } from "../file-system-port";
import { parseSkillFrontmatter, sanitizeSkillFolderName } from "../skills/skill-frontmatter";
import type { SkillRecord, SkillScope, SkillsPrefs } from "../skills/skill-types";
import { JsonStore } from "../storage/json-store";

function sameDir(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

const execFileAsync = promisify(execFile);

export interface SkillsServiceDeps {
  fs: FileSystemPort;
  storageRoot: string;
  /** 当前活动仓库根；没有时项目级安装不可用。 */
  workspaceRoot(): string | undefined;
  /** 托管 GROK_HOME；没有时用户级装到 storageRoot/grok-home。 */
  grokHome(): string | undefined;
  onChanged?: () => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SkillsService {
  private readonly store: JsonStore;
  private prefs: SkillsPrefs = { disabled: [] };
  private loaded = false;

  constructor(private readonly deps: SkillsServiceDeps) {
    this.store = new JsonStore(deps.fs);
  }

  private prefsFile(): string {
    return path.join(this.deps.storageRoot, "agent-skills", "prefs.json");
  }

  /** 面板「安装到用户」与托管 GROK_HOME 下的 skills（灵动运行时默认扫这里）。 */
  userSkillsRoot(): string {
    const home = this.deps.grokHome()?.trim()
      || path.join(this.deps.storageRoot, "grok-home");
    return path.join(home, "skills");
  }

  /**
   * Grok CLI / Agent 常把用户级技能装到 `~/.grok/skills`。
   * 灵动托管 GROK_HOME 时与它不是同一目录，必须额外扫描，否则面板会空。
   */
  nativeUserSkillsRoot(): string {
    return path.join(os.homedir(), ".grok", "skills");
  }

  /** 用户级扫描根：托管目录 +（若不同）本机 ~/.grok/skills。 */
  userSkillScanRoots(): string[] {
    const managed = this.userSkillsRoot();
    const native = this.nativeUserSkillsRoot();
    return sameDir(managed, native) ? [managed] : [managed, native];
  }

  /**
   * 写入 config.toml `[skills].paths`：让运行中的 Grok（GROK_HOME=托管目录）
   * 也能加载装在 ~/.grok/skills 里的技能。
   */
  async skillConfigPaths(): Promise<string[]> {
    const managed = this.userSkillsRoot();
    const native = this.nativeUserSkillsRoot();
    if (sameDir(managed, native)) return [];
    if (!(await this.deps.fs.exists(native))) return [];
    return [native];
  }

  workspaceSkillsRoot(): string | undefined {
    const root = this.deps.workspaceRoot()?.trim();
    return root ? path.join(root, ".grok", "skills") : undefined;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const result = await this.store.read<SkillsPrefs>(this.prefsFile(), {
      kind: "skills-prefs",
      fallback: () => ({ disabled: [] }),
      validate: (data) => {
        if (typeof data !== "object" || data === null) return undefined;
        const disabled = (data as { disabled?: unknown }).disabled;
        if (!Array.isArray(disabled)) return undefined;
        return {
          disabled: disabled
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean),
        };
      },
    });
    this.prefs = result.data;
    this.loaded = true;
  }

  async disabledNames(): Promise<string[]> {
    await this.load();
    return [...this.prefs.disabled];
  }

  async setDisabled(names: readonly string[]): Promise<void> {
    await this.load();
    const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort();
    this.prefs = { disabled: unique };
    await this.store.write(this.prefsFile(), "skills-prefs", this.prefs);
    this.deps.onChanged?.();
  }

  async list(): Promise<SkillRecord[]> {
    await this.load();
    const disabled = new Set(this.prefs.disabled);
    const out: SkillRecord[] = [];
    const seen = new Set<string>();

    const roots: Array<{ scope: SkillScope; root: string }> = [];
    const workspaceRoot = this.workspaceSkillsRoot();
    if (workspaceRoot) roots.push({ scope: "workspace", root: workspaceRoot });
    for (const root of this.userSkillScanRoots()) {
      roots.push({ scope: "user", root });
    }

    for (const { scope, root } of roots) {
      if (!(await this.deps.fs.exists(root))) continue;
      const entries = await this.deps.fs.listEntries(root);
      for (const entry of entries) {
        if (!entry.isDirectory) continue;
        const directory = path.join(root, entry.name);
        const skillFile = path.join(directory, "SKILL.md");
        if (!(await this.deps.fs.exists(skillFile))) continue;
        const bytes = await this.deps.fs.read(skillFile);
        if (!bytes) continue;
        const fm = parseSkillFrontmatter(Buffer.from(bytes).toString("utf8"));
        const name = (fm.name || entry.name).trim();
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        out.push({
          name,
          description: (fm.description || "").trim(),
          scope,
          directory,
          disabled: disabled.has(name),
        });
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    return out;
  }

  async installFromFolder(sourceDir: string, scope: SkillScope): Promise<SkillRecord> {
    const skillFile = path.join(sourceDir, "SKILL.md");
    const bytes = await this.deps.fs.read(skillFile);
    if (!bytes) throw new Error("所选目录缺少 SKILL.md。");
    const fm = parseSkillFrontmatter(Buffer.from(bytes).toString("utf8"));
    const folderName = sanitizeSkillFolderName(fm.name || path.basename(sourceDir));
    const targetRoot = scope === "workspace" ? this.workspaceSkillsRoot() : this.userSkillsRoot();
    if (!targetRoot) throw new Error("当前没有活动仓库，无法安装到项目级。");
    const target = path.join(targetRoot, folderName);
    if (await this.deps.fs.exists(target)) {
      throw new Error(`目标已存在：${folderName}`);
    }
    await this.deps.fs.ensureDirectory(targetRoot);
    await this.copyDirectory(sourceDir, target);
    this.deps.onChanged?.();
    const listed = await this.list();
    const found = listed.find((item) => item.directory === target);
    if (!found) throw new Error("安装完成但未能读回技能。");
    return found;
  }

  async installFromZip(zipPath: string, scope: SkillScope): Promise<SkillRecord> {
    const tempRoot = path.join(
      this.deps.storageRoot,
      "agent-skills",
      "tmp",
      `extract-${Date.now()}`,
    );
    await this.deps.fs.ensureDirectory(tempRoot);
    try {
      await this.extractZip(zipPath, tempRoot);
      const source = await this.findSkillRoot(tempRoot);
      if (!source) throw new Error("压缩包内未找到 SKILL.md。");
      return await this.installFromFolder(source, scope);
    } finally {
      await this.deps.fs.removeDirectory(tempRoot).catch(() => undefined);
    }
  }

  async remove(name: string, scope: SkillScope): Promise<void> {
    const skills = await this.list();
    const target = skills.find((item) => item.name === name && item.scope === scope);
    if (!target) throw new Error("找不到要删除的技能。");
    await this.deps.fs.removeDirectory(target.directory);
    const disabled = (await this.disabledNames()).filter((item) => item !== name);
    await this.setDisabled(disabled);
    this.deps.onChanged?.();
  }

  async setSkillEnabled(name: string, enabled: boolean): Promise<void> {
    const disabled = new Set(await this.disabledNames());
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    await this.setDisabled([...disabled]);
  }

  private async extractZip(zipPath: string, dest: string): Promise<void> {
    try {
      await execFileAsync("tar", ["-xf", zipPath, "-C", dest], { windowsHide: true });
    } catch (error) {
      throw new Error(`解压失败：${errorText(error)}`);
    }
  }

  private async findSkillRoot(root: string): Promise<string | undefined> {
    if (await this.deps.fs.exists(path.join(root, "SKILL.md"))) return root;
    const entries = await this.deps.fs.listEntries(root);
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      const nested = path.join(root, entry.name);
      if (await this.deps.fs.exists(path.join(nested, "SKILL.md"))) return nested;
      const deeper = await this.findSkillRoot(nested);
      if (deeper) return deeper;
    }
    return undefined;
  }

  private async copyDirectory(from: string, to: string): Promise<void> {
    await this.deps.fs.ensureDirectory(to);
    const entries = await this.deps.fs.listEntries(from);
    for (const entry of entries) {
      const src = path.join(from, entry.name);
      const dest = path.join(to, entry.name);
      if (entry.isDirectory) {
        await this.copyDirectory(src, dest);
        continue;
      }
      const bytes = await this.deps.fs.read(src);
      if (bytes) await this.deps.fs.write(dest, bytes);
    }
  }
}
