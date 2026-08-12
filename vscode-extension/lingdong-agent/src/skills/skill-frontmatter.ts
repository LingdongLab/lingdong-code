/** 从 SKILL.md 提取 YAML frontmatter 的 name / description。 */

export interface SkillFrontmatter {
  name?: string;
  description?: string;
}

export function parseSkillFrontmatter(markdown: string): SkillFrontmatter {
  const text = markdown.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = text.slice(3, end).replace(/^\r?\n/, "");
  const out: SkillFrontmatter = {};
  for (const line of block.split(/\r?\n/)) {
    const match = /^(name|description)\s*:\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1] as "name" | "description";
    let value = match[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value.trim();
  }
  return out;
}

export function sanitizeSkillFolderName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._\u4e00-\u9fff-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug.slice(0, 64) || "skill";
}
