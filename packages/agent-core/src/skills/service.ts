import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PROJECT_STATE_DIR_NAME, USER_DATA_DIR_NAME } from "@archcode/protocol";
import { BUILTIN_SKILL_PACKAGES } from "./builtin/manifest";
import {
  activateBuiltinSkill,
  activateFilesystemSkill,
  assertFilesystemSkillAncestry,
  discoverBuiltinSkill,
  discoverFilesystemSkill,
  filesystemSkillDirectoryExists,
  readBuiltinSkillResource,
  readFilesystemSkillResource,
  SkillPackageResourceNotFoundError,
} from "./package-reader";
import { assertSkillName } from "./schema";
import type {
  BuiltinSkillPackage,
  ResolvedSkill,
  ResolvedSkillResource,
  SkillIndexEntry,
  SkillMetadata,
  SkillSource,
} from "./types";

const PROJECT_SKILLS_DIR = join(PROJECT_STATE_DIR_NAME, "skills");

export const RESERVED_BUILTIN_SKILL_NAMES = new Set([
  "automation-create",
  "orchestrate-work",
  "plan-work",
  "execute-plan",
  "run-goal",
  "shape-todo",
  "review-work",
  "goal-review",
]);

export class SkillPathError extends Error {
  public readonly path: string;
  public readonly reason: string;

  constructor(path: string, reason: string) {
    super(`Skill path error: ${reason} (path: "${path}")`);
    this.name = "SkillPathError";
    this.path = path;
    this.reason = reason;
  }
}

export class SkillNotFoundError extends Error {
  public readonly skillName: string;

  constructor(skillName: string) {
    super(`Skill not found: ${skillName}`);
    this.name = "SkillNotFoundError";
    this.skillName = skillName;
  }
}

export class SkillResourceNotFoundError extends Error {
  constructor(
    public readonly skillName: string,
    public readonly resource: string,
  ) {
    super(`Skill resource not found: ${skillName}/${resource}`);
    this.name = "SkillResourceNotFoundError";
  }
}

export class SkillValidationError extends Error {
  public readonly skillName: string;
  public readonly source: SkillSource;
  public readonly path?: string;

  constructor(params: {
    skillName: string;
    source: SkillSource;
    message: string;
    path?: string;
    cause?: unknown;
  }) {
    super(`Invalid ${params.source} skill "${params.skillName}": ${params.message}`, {
      cause: params.cause,
    });
    this.name = "SkillValidationError";
    this.skillName = params.skillName;
    this.source = params.source;
    this.path = params.path;
  }
}

export interface SkillServiceOptions {
  readonly userSkillsRoot?: string;
  readonly builtinSkills?: Readonly<Record<string, BuiltinSkillPackage>>;
}

type SkillCandidate =
  | {
      readonly source: "project" | "user";
      readonly boundaryRoot: string;
      readonly root: string;
    }
  | {
      readonly source: "builtin";
      readonly skillPackage: BuiltinSkillPackage;
    };

export class SkillService {
  public readonly userSkillsRoot: string;
  readonly #userSkillsBoundaryRoot: string;
  readonly #builtinSkills: Readonly<Record<string, BuiltinSkillPackage>>;

  constructor(options: SkillServiceOptions = {}) {
    const defaultUserRoot = options.userSkillsRoot === undefined;
    this.userSkillsRoot = resolve(options.userSkillsRoot ?? join(homedir(), USER_DATA_DIR_NAME, "skills"));
    this.#userSkillsBoundaryRoot = defaultUserRoot ? resolve(homedir()) : dirname(this.userSkillsRoot);
    this.#builtinSkills = options.builtinSkills ?? BUILTIN_SKILL_PACKAGES;
  }

  async listForAgent(
    projectRoot: string,
    allowedNames?: readonly string[],
  ): Promise<SkillIndexEntry[]> {
    const names = await this.#discoverNames(projectRoot, allowedNames);
    const entries: SkillIndexEntry[] = [];

    for (const name of names) {
      const entry = await this.discoverForAgent(projectRoot, name, allowedNames);
      if (entry !== null) entries.push(entry);
    }
    return entries.sort((a, b) => lexicalCompare(a.name, b.name));
  }

  async discoverForAgent(
    projectRoot: string,
    name: string,
    allowedNames?: readonly string[],
  ): Promise<SkillIndexEntry | null> {
    assertSkillName(name);
    const candidate = await this.#resolveWinningCandidate(projectRoot, name, allowedNames);
    if (candidate === null) return null;
    const metadata = await this.#discoverCandidate(name, candidate);
    return { name: metadata.name, description: metadata.description, source: candidate.source };
  }

  async readForAgent(
    projectRoot: string,
    name: string,
    allowedNames?: readonly string[],
  ): Promise<ResolvedSkill | null> {
    assertSkillName(name);
    const candidate = await this.#resolveWinningCandidate(projectRoot, name, allowedNames);
    if (candidate === null) return null;
    try {
      const activated = candidate.source === "builtin"
        ? activateBuiltinSkill(candidate.skillPackage, name)
        : await activateFilesystemSkill(candidate, name);
      return {
        metadata: activated.metadata,
        body: activated.body,
        source: candidate.source,
        sourceLabel: candidate.source === "builtin" ? "builtin" : candidate.root,
        ...(candidate.source === "builtin" ? {} : { root: candidate.root }),
        resources: activated.resources,
      };
    } catch (error) {
      throw this.#validationError(name, candidate, error);
    }
  }

  async readResourceForAgent(
    projectRoot: string,
    name: string,
    resource: string,
    allowedNames?: readonly string[],
  ): Promise<ResolvedSkillResource | null> {
    assertSkillName(name);
    const candidate = await this.#resolveWinningCandidate(projectRoot, name, allowedNames);
    if (candidate === null) return null;
    try {
      const read = candidate.source === "builtin"
        ? readBuiltinSkillResource(candidate.skillPackage, name, resource)
        : await readFilesystemSkillResource(candidate, name, resource);
      return {
        skillName: name,
        source: candidate.source,
        sourceLabel: candidate.source === "builtin" ? "builtin" : candidate.root,
        ...(candidate.source === "builtin" ? {} : { root: candidate.root }),
        resource: read.descriptor,
        content: read.content,
      };
    } catch (error) {
      if (error instanceof SkillPackageResourceNotFoundError) {
        throw new SkillResourceNotFoundError(name, resource);
      }
      throw this.#validationError(name, candidate, error);
    }
  }

  async #discoverNames(
    projectRoot: string,
    allowedNames?: readonly string[],
  ): Promise<string[]> {
    const allowed = allowedNames === undefined ? null : new Set(allowedNames);
    const names = new Set<string>();
    const filesystemSources = [
      { boundaryRoot: resolve(projectRoot), root: this.#projectSkillsRoot(projectRoot) },
      { boundaryRoot: this.#userSkillsBoundaryRoot, root: this.userSkillsRoot },
    ] as const;
    for (const source of filesystemSources) {
      for (const name of await this.#listSkillDirs(source.boundaryRoot, source.root)) {
        if (!RESERVED_BUILTIN_SKILL_NAMES.has(name)) names.add(name);
      }
    }
    for (const name of Object.keys(this.#builtinSkills)) {
      if (allowed === null || allowed.has(name)) names.add(name);
    }
    return [...names].sort(lexicalCompare);
  }

  async #resolveWinningCandidate(
    projectRoot: string,
    name: string,
    allowedNames?: readonly string[],
  ): Promise<SkillCandidate | null> {
    const allowed = allowedNames === undefined || allowedNames.includes(name);
    const builtin = Object.hasOwn(this.#builtinSkills, name)
      ? this.#builtinSkills[name]
      : undefined;
    if (RESERVED_BUILTIN_SKILL_NAMES.has(name)) {
      return allowed && builtin !== undefined
        ? { source: "builtin", skillPackage: builtin }
        : null;
    }

    const projectPackageRoot = resolve(this.#projectSkillsRoot(projectRoot), name);
    const projectCandidate = {
      source: "project" as const,
      boundaryRoot: resolve(projectRoot),
      root: projectPackageRoot,
    };
    if (await this.#filesystemCandidateExists(projectCandidate)) {
      return projectCandidate;
    }
    const userPackageRoot = resolve(this.userSkillsRoot, name);
    const userCandidate = {
      source: "user" as const,
      boundaryRoot: this.#userSkillsBoundaryRoot,
      root: userPackageRoot,
    };
    if (await this.#filesystemCandidateExists(userCandidate)) {
      return userCandidate;
    }
    return allowed && builtin !== undefined
      ? { source: "builtin", skillPackage: builtin }
      : null;
  }

  async #discoverCandidate(name: string, candidate: SkillCandidate): Promise<SkillMetadata> {
    try {
      return candidate.source === "builtin"
        ? discoverBuiltinSkill(candidate.skillPackage, name)
        : await discoverFilesystemSkill(candidate, name);
    } catch (error) {
      throw this.#validationError(name, candidate, error);
    }
  }

  #validationError(name: string, candidate: SkillCandidate, error: unknown): SkillValidationError {
    return new SkillValidationError({
      skillName: name,
      source: candidate.source,
      ...(candidate.source === "builtin" ? {} : { path: candidate.root }),
      message: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  }

  async #filesystemCandidateExists(
    candidate: Extract<SkillCandidate, { readonly source: "project" | "user" }>,
  ): Promise<boolean> {
    try {
      return await filesystemSkillDirectoryExists(candidate);
    } catch (error) {
      throw new SkillPathError(candidate.root, error instanceof Error ? error.message : String(error));
    }
  }

  #projectSkillsRoot(projectRoot: string): string {
    return resolve(projectRoot, PROJECT_SKILLS_DIR);
  }

  async #listSkillDirs(boundaryRoot: string, root: string): Promise<string[]> {
    try {
      await assertFilesystemSkillAncestry({ boundaryRoot, root });
      const entries = await readdir(root, { withFileTypes: true });
      const names = entries
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name)
        .filter((name) => {
          try {
            assertSkillName(name);
            return true;
          } catch {
            return false;
          }
        })
        .sort(lexicalCompare);
      await assertFilesystemSkillAncestry({ boundaryRoot, root });
      return names;
    } catch (error) {
      if (isNoEntryError(error)) return [];
      throw new SkillPathError(root, error instanceof Error ? error.message : String(error));
    }
  }
}

function isNoEntryError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function lexicalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
