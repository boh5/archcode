import { SKILL_SOURCE_TIERS } from "@archcode/protocol";

export const SKILL_SOURCE_PRECEDENCE = SKILL_SOURCE_TIERS;

export type SkillSource = typeof SKILL_SOURCE_PRECEDENCE[number];

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

export interface SkillDiagnostic {
  readonly name: string;
  readonly source: SkillSource;
  readonly code: "SKILL_INVALID_PACKAGE";
  readonly message: string;
}

export interface SkillInventoryRecord {
  readonly name: string;
  readonly source: SkillSource;
  readonly sourceLabel: string;
  readonly winner: boolean;
  readonly shadowed: boolean;
  readonly valid: boolean;
  readonly description?: string;
  readonly diagnostic?: SkillDiagnostic;
}

export interface SkillCatalog {
  readonly entries: readonly SkillIndexEntry[];
  readonly inventory: readonly SkillInventoryRecord[];
  readonly diagnostics: readonly SkillDiagnostic[];
  readonly digest: string;
}

export interface SkillPromptProjection {
  readonly includedEntries: readonly SkillIndexEntry[];
  readonly omittedCount: number;
  readonly renderedText: string;
  readonly byteLength: number;
}

export interface SkillPackageFingerprint {
  readonly source: SkillSource;
  readonly digest: string;
}

export interface SkillPackageSnapshot extends SkillPackageFingerprint {
  readonly name: string;
  readonly sourceLabel: string;
  readonly root?: string;
  readonly metadata: SkillMetadata;
  readonly body: string;
  readonly resources: readonly SkillResourceDescriptor[];
  readEntry(): ResolvedSkill;
  readResource(resource: string): ResolvedSkillResource;
}

/** Complete embedded package. Resource values preserve bytes; no filesystem fallback exists. */
export interface BuiltinSkillPackage {
  readonly entry: string;
  readonly resources: Readonly<Record<string, string | Uint8Array>>;
}
