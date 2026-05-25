import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BUILTIN_SKILL_BODIES } from "./builtin/manifest";
import { assertSkillName, parseSkillMarkdown } from "./schema";
import type { ResolvedSkill, SkillIndexEntry, SkillSource } from "./types";
import { resolveContainedPath, SafePathError } from "../utils/safe-file";

const PROJECT_SKILLS_DIR = join(".specra", "skills");
const SKILL_FILE = "SKILL.md";

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
  userSkillsRoot?: string;
  builtinSkills?: Record<string, string>;
}

interface SkillCandidate {
  source: SkillSource;
  path?: string;
  content?: string;
}

export class SkillService {
  public readonly userSkillsRoot: string;
  readonly #builtinSkills: Record<string, string>;

  constructor(options: SkillServiceOptions = {}) {
    this.userSkillsRoot = resolve(options.userSkillsRoot ?? join(homedir(), ".specra", "skills"));
    this.#builtinSkills = options.builtinSkills ?? BUILTIN_SKILL_BODIES;
  }

  async listForAgent(
    projectRoot: string,
    allowedNames?: readonly string[],
  ): Promise<SkillIndexEntry[]> {
    const names = await this.#discoverNames(projectRoot, allowedNames);
    const entries: SkillIndexEntry[] = [];

    for (const name of names) {
      const skill = await this.readForAgent(projectRoot, name, allowedNames);
      if (skill === null) continue;
      entries.push({
        name: skill.metadata.name,
        description: skill.metadata.description,
        source: skill.source,
        allowed_tools: skill.metadata.allowed_tools,
      });
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async readForAgent(
    projectRoot: string,
    name: string,
    allowedNames?: readonly string[],
  ): Promise<ResolvedSkill | null> {
    this.#assertAllowedName(name, allowedNames);
    assertSkillName(name);

    const candidates = await this.#candidates(projectRoot, name);
    for (const candidate of candidates) {
      if (candidate.content === undefined) continue;
      return this.#parseCandidate(name, candidate);
    }

    return null;
  }

  async #discoverNames(
    projectRoot: string,
    allowedNames?: readonly string[],
  ): Promise<string[]> {
    const allowed = allowedNames === undefined ? null : new Set(allowedNames);
    const names = new Set<string>();

    for (const root of [this.#projectSkillsRoot(projectRoot), this.userSkillsRoot]) {
      for (const name of await this.#listSkillDirs(root)) {
        if (allowed !== null && !allowed.has(name)) continue;
        names.add(name);
      }
    }

    for (const name of Object.keys(this.#builtinSkills)) {
      if (allowed !== null && !allowed.has(name)) continue;
      names.add(name);
    }

    return [...names].sort();
  }

  async #candidates(projectRoot: string, name: string): Promise<SkillCandidate[]> {
    const projectPath = await this.#resolveSkillPath(this.#projectSkillsRoot(projectRoot), name);
    const userPath = await this.#resolveSkillPath(this.userSkillsRoot, name);
    const builtin = this.#builtinSkills[name];

    return [
      { source: "project", path: projectPath, content: await this.#readFileOrUndefined(projectPath) },
      { source: "user", path: userPath, content: await this.#readFileOrUndefined(userPath) },
      { source: "builtin", content: builtin },
    ];
  }

  #parseCandidate(requestedName: string, candidate: SkillCandidate): ResolvedSkill {
    try {
      const content = candidate.content;
      if (content === undefined) throw new Error("Skill content is missing");
      const { metadata, body } = parseSkillMarkdown(content);
      if (metadata.name !== requestedName) {
        throw new Error(
          `frontmatter.name must match requested skill "${requestedName}" (received "${metadata.name}")`,
        );
      }
      return {
        metadata,
        body,
        source: candidate.source,
        path: candidate.path,
      };
    } catch (error) {
      throw new SkillValidationError({
        skillName: requestedName,
        source: candidate.source,
        path: candidate.path,
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
  }

  #assertAllowedName(name: string, allowedNames?: readonly string[]): void {
    if (allowedNames !== undefined && !allowedNames.includes(name)) {
      throw new SkillNotFoundError(name);
    }
  }

  #projectSkillsRoot(projectRoot: string): string {
    return resolve(projectRoot, PROJECT_SKILLS_DIR);
  }

  async #resolveSkillPath(root: string, name: string): Promise<string> {
    try {
      return await resolveContainedPath(join(name, SKILL_FILE), root);
    } catch (error) {
      if (error instanceof SafePathError) {
        throw new SkillPathError(error.path, error.reason);
      }
      throw error;
    }
  }

  async #listSkillDirs(root: string): Promise<string[]> {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => {
          try {
            assertSkillName(name);
            return true;
          } catch {
            return false;
          }
        })
        .sort();
    } catch {
      return [];
    }
  }

  async #readFileOrUndefined(filePath: string): Promise<string | undefined> {
    try {
      const file = Bun.file(filePath);
      if (!(await file.exists())) return undefined;
      return await file.text();
    } catch {
      return undefined;
    }
  }
}
