export type SkillSource = "project" | "user" | "builtin";

export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface SkillResourceDescriptor {
  readonly path: string;
  readonly bytes: number;
}

export interface ResolvedSkill {
  readonly metadata: SkillMetadata;
  readonly body: string;
  readonly source: SkillSource;
  readonly sourceLabel: string;
  /** Absolute package root for project/user Skills. Embedded builtins intentionally have no pretend path. */
  readonly root?: string;
  readonly resources: readonly SkillResourceDescriptor[];
}

export interface ResolvedSkillResource {
  readonly skillName: string;
  readonly source: SkillSource;
  readonly sourceLabel: string;
  readonly root?: string;
  readonly resource: SkillResourceDescriptor;
  readonly content: Uint8Array;
}

export interface SkillIndexEntry {
  readonly name: string;
  readonly description: string;
  readonly source: SkillSource;
}

/** Complete embedded package. Resource values preserve bytes; no filesystem fallback exists. */
export interface BuiltinSkillPackage {
  readonly entry: string;
  readonly resources: Readonly<Record<string, string | Uint8Array>>;
}
