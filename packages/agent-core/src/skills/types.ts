export type SkillSource = "project" | "user" | "builtin";

export interface SkillMetadata {
  name: string;
  description: string;
  allowed_tools?: string[];
}

export interface ResolvedSkill {
  metadata: SkillMetadata;
  body: string;
  source: SkillSource;
  path?: string;
}

export interface SkillIndexEntry {
  name: string;
  description: string;
  source: SkillSource;
  allowed_tools?: string[];
}
