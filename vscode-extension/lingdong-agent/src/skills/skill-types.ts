export type SkillScope = "user" | "workspace";

export interface SkillRecord {
  name: string;
  description: string;
  scope: SkillScope;
  /** 技能目录绝对路径。 */
  directory: string;
  disabled: boolean;
}

export interface SkillsPrefs {
  disabled: string[];
}
