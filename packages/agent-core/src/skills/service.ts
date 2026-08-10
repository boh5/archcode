import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PROJECT_STATE_DIR_NAME, USER_DATA_DIR_NAME } from "@archcode/protocol";
import { BUILTIN_SKILL_PACKAGES } from "./builtin/manifest";
import { paginateDigestBound, type DigestBoundPage } from "./pagination";
import {
  assertFilesystemSkillAncestry,
  discoverBuiltinSkill,
  discoverFilesystemSkill,
  SkillPackageResourceNotFoundError,
  snapshotBuiltinSkill,
  snapshotFilesystemSkill,
} from "./package-reader";
import { projectAvailableSkills } from "./projection";
import { assertSkillName } from "./schema";
import type {
  BuiltinSkillPackage,
  ResolvedSkill,
  ResolvedSkillResource,
  SkillCatalog,
  SkillDiagnostic,
  SkillIndexEntry,
  SkillInventoryRecord,
  SkillMetadata,
  SkillPackageSnapshot,
  SkillPackageFingerprint,
  SkillPromptProjection,
  SkillSource,
} from "./types";

const PROJECT_ARCHCODE_SKILLS_DIR = join(PROJECT_STATE_DIR_NAME, "skills");
const PROJECT_AGENTS_SKILLS_DIR = join(".agents", "skills");

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
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`Skill path error: ${reason} (path: "${path}")`);
    this.name = "SkillPathError";
  }
}

export class SkillNotFoundError extends Error {
  constructor(public readonly skillName: string) {
    super(`Skill not found: ${skillName}`);
    this.name = "SkillNotFoundError";
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

export class SkillPackageChangedError extends Error {
  public readonly code = "SKILL_PACKAGE_CHANGED" as const;

  constructor(public readonly skillName: string) {
    super(`Skill package changed since Execution claim: ${skillName}`);
    this.name = "SkillPackageChangedError";
  }
}

export class SkillValidationError extends Error {
  constructor(
    public readonly skillName: string,
    public readonly source: SkillSource,
    message: string,
    public readonly path?: string,
    options?: ErrorOptions,
  ) {
    super(`Invalid ${source} skill "${skillName}": ${message}`, options);
    this.name = "SkillValidationError";
  }
}

export interface SkillServiceOptions {
  readonly userSkillsRoot?: string;
  readonly userAgentsSkillsRoot?: string;
  readonly builtinSkills?: Readonly<Record<string, BuiltinSkillPackage>>;
}

interface FilesystemSource {
  readonly source: Exclude<SkillSource, "builtin">;
  readonly boundaryRoot: string;
  readonly root: string;
}

type SkillCandidate =
  | (FilesystemSource & { readonly packageRoot: string })
  | { readonly source: "builtin"; readonly skillPackage: BuiltinSkillPackage };

export class SkillService {
  public readonly userSkillsRoot: string;
  public readonly userAgentsSkillsRoot: string;
  readonly #userArchcodeBoundaryRoot: string;
  readonly #userAgentsBoundaryRoot: string;
  readonly #builtinSkills: Readonly<Record<string, BuiltinSkillPackage>>;

  constructor(options: SkillServiceOptions = {}) {
    this.userSkillsRoot = resolve(options.userSkillsRoot ?? join(homedir(), USER_DATA_DIR_NAME, "skills"));
    this.userAgentsSkillsRoot = resolve(options.userAgentsSkillsRoot ?? join(homedir(), ".agents", "skills"));
    this.#userArchcodeBoundaryRoot = options.userSkillsRoot === undefined ? resolve(homedir()) : dirname(this.userSkillsRoot);
    this.#userAgentsBoundaryRoot = options.userAgentsSkillsRoot === undefined
      ? resolve(homedir())
      : dirname(this.userAgentsSkillsRoot);
    this.#builtinSkills = options.builtinSkills ?? BUILTIN_SKILL_PACKAGES;
  }

  async catalogForAgent(
    projectRoot: string,
    allowedNames?: readonly string[],
  ): Promise<SkillCatalog> {
    const allowed = allowedNames === undefined ? null : new Set(allowedNames);
    const sources = this.#filesystemSources(projectRoot);
    const namesBySource = await Promise.all(sources.map(async (source) => ({
      source,
      names: await this.#listSkillDirs(source.boundaryRoot, source.root),
    })));
    const names = new Set<string>();
    for (const item of namesBySource) {
      for (const name of item.names) {
        names.add(name);
      }
    }
    for (const name of Object.keys(this.#builtinSkills)) {
      if (allowed === null || allowed.has(name)) names.add(name);
    }

    const entries: SkillIndexEntry[] = [];
    const inventory: SkillInventoryRecord[] = [];
    const diagnostics: SkillDiagnostic[] = [];
    for (const name of [...names].sort(lexicalCompare)) {
      const candidates: SkillCandidate[] = [];
      for (const { source, names: sourceNames } of namesBySource) {
        if (sourceNames.includes(name)) {
          candidates.push({ ...source, packageRoot: resolve(source.root, name) });
        }
      }
      const builtin = Object.hasOwn(this.#builtinSkills, name) ? this.#builtinSkills[name] : undefined;
      if (builtin !== undefined && (allowed === null || allowed.has(name))) {
        candidates.push({ source: "builtin", skillPackage: builtin });
      }
      const winnerIndex = RESERVED_BUILTIN_SKILL_NAMES.has(name)
        ? candidates.findIndex((candidate) => candidate.source === "builtin")
        : (candidates.length === 0 ? -1 : 0);
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index]!;
        const winner = index === winnerIndex;
        try {
          const metadata = await this.#discoverCandidate(name, candidate);
          inventory.push(Object.freeze({
            name,
            source: candidate.source,
            sourceLabel: this.#sourceLabel(candidate),
            winner,
            shadowed: !winner,
            valid: true,
            description: metadata.description,
          }));
          if (winner) entries.push(Object.freeze({
            name,
            description: metadata.description,
            source: candidate.source,
          }));
        } catch (error) {
          const diagnostic = this.#diagnostic(name, candidate, error);
          diagnostics.push(diagnostic);
          inventory.push(Object.freeze({
            name,
            source: candidate.source,
            sourceLabel: this.#sourceLabel(candidate),
            winner,
            shadowed: !winner,
            valid: false,
            diagnostic,
          }));
        }
      }
    }
    const frozenEntries = Object.freeze(entries);
    const frozenInventory = Object.freeze(inventory);
    const frozenDiagnostics = Object.freeze(diagnostics);
    return Object.freeze({
      entries: frozenEntries,
      inventory: frozenInventory,
      diagnostics: frozenDiagnostics,
      digest: stableDigest({ entries: frozenEntries, inventory: frozenInventory, diagnostics: frozenDiagnostics }),
    });
  }

  async listForAgent(projectRoot: string, allowedNames?: readonly string[]): Promise<SkillIndexEntry[]> {
    return [...(await this.catalogForAgent(projectRoot, allowedNames)).entries];
  }

  async listPageForAgent(
    projectRoot: string,
    allowedNames?: readonly string[],
    cursor?: string,
  ): Promise<DigestBoundPage<SkillIndexEntry>> {
    const catalog = await this.catalogForAgent(projectRoot, allowedNames);
    return paginateDigestBound({
      items: catalog.entries,
      digest: catalog.digest,
      ...(cursor === undefined ? {} : { cursor }),
      maxItems: 50,
      maxSerializedBytes: 24 * 1024,
      staleCursorCode: "TOOL_SKILL_CATALOG_CHANGED",
    });
  }

  async inventoryPage(
    projectRoot: string,
    cursor?: string,
    allowedNames?: readonly string[],
  ): Promise<DigestBoundPage<SkillInventoryRecord>> {
    const catalog = await this.catalogForAgent(projectRoot, allowedNames);
    return paginateDigestBound({
      items: catalog.inventory,
      digest: catalog.digest,
      ...(cursor === undefined ? {} : { cursor }),
      maxItems: 50,
      maxSerializedBytes: 64 * 1024,
      staleCursorCode: "SKILL_INVENTORY_CHANGED",
    });
  }

  async projectPromptCatalog(
    projectRoot: string,
    allowedNames?: readonly string[],
  ): Promise<SkillPromptProjection> {
    return projectAvailableSkills((await this.catalogForAgent(projectRoot, allowedNames)).entries);
  }

  async discoverForAgent(
    projectRoot: string,
    name: string,
    allowedNames?: readonly string[],
  ): Promise<SkillIndexEntry | null> {
    assertSkillName(name);
    const candidate = await this.#resolveWinningCandidate(projectRoot, name, allowedNames);
    if (candidate === null) return null;
    try {
      const metadata = await this.#discoverCandidate(name, candidate);
      return { name, description: metadata.description, source: candidate.source };
    } catch (error) {
      throw this.#validationError(name, candidate, error);
    }
  }

  async snapshotForAgent(
    projectRoot: string,
    name: string,
    allowedNames?: readonly string[],
  ): Promise<SkillPackageSnapshot | null> {
    assertSkillName(name);
    const candidate = await this.#resolveWinningCandidate(projectRoot, name, allowedNames);
    if (candidate === null) return null;
    try {
      return await this.#snapshotCandidate(name, candidate);
    } catch (error) {
      throw this.#validationError(name, candidate, error);
    }
  }

  async restoreSnapshotForAgent(
    projectRoot: string,
    name: string,
    expected: SkillPackageFingerprint,
    allowedNames?: readonly string[],
  ): Promise<SkillPackageSnapshot> {
    let snapshot: SkillPackageSnapshot | null;
    try {
      snapshot = await this.snapshotForAgent(projectRoot, name, allowedNames);
    } catch {
      throw new SkillPackageChangedError(name);
    }
    if (
      snapshot === null
      || snapshot.source !== expected.source
      || snapshot.digest !== expected.digest
    ) {
      throw new SkillPackageChangedError(name);
    }
    return snapshot;
  }

  async readForAgent(
    projectRoot: string,
    name: string,
    allowedNames?: readonly string[],
  ): Promise<ResolvedSkill | null> {
    return (await this.snapshotForAgent(projectRoot, name, allowedNames))?.readEntry() ?? null;
  }

  async readResourceForAgent(
    projectRoot: string,
    name: string,
    resource: string,
    allowedNames?: readonly string[],
  ): Promise<ResolvedSkillResource | null> {
    const snapshot = await this.snapshotForAgent(projectRoot, name, allowedNames);
    if (snapshot === null) return null;
    try {
      return snapshot.readResource(resource);
    } catch (error) {
      if (error instanceof SkillPackageResourceNotFoundError) {
        throw new SkillResourceNotFoundError(name, resource);
      }
      throw error;
    }
  }

  async #resolveWinningCandidate(
    projectRoot: string,
    name: string,
    allowedNames?: readonly string[],
  ): Promise<SkillCandidate | null> {
    const builtinAllowed = allowedNames === undefined || allowedNames.includes(name);
    const builtin = Object.hasOwn(this.#builtinSkills, name) ? this.#builtinSkills[name] : undefined;
    if (RESERVED_BUILTIN_SKILL_NAMES.has(name)) {
      return builtin === undefined || !builtinAllowed ? null : { source: "builtin", skillPackage: builtin };
    }
    for (const source of this.#filesystemSources(projectRoot)) {
      const packageRoot = resolve(source.root, name);
      if (await candidateIsPresent(packageRoot)) return { ...source, packageRoot };
    }
    return builtin === undefined || !builtinAllowed ? null : { source: "builtin", skillPackage: builtin };
  }

  #filesystemSources(projectRoot: string): readonly FilesystemSource[] {
    const projectBoundary = resolve(projectRoot);
    return [
      { source: "project-archcode", boundaryRoot: projectBoundary, root: resolve(projectRoot, PROJECT_ARCHCODE_SKILLS_DIR) },
      { source: "project-agents", boundaryRoot: projectBoundary, root: resolve(projectRoot, PROJECT_AGENTS_SKILLS_DIR) },
      { source: "user-archcode", boundaryRoot: this.#userArchcodeBoundaryRoot, root: this.userSkillsRoot },
      { source: "user-agents", boundaryRoot: this.#userAgentsBoundaryRoot, root: this.userAgentsSkillsRoot },
    ];
  }

  async #snapshotCandidate(name: string, candidate: SkillCandidate): Promise<SkillPackageSnapshot> {
    return candidate.source === "builtin"
      ? snapshotBuiltinSkill(candidate.skillPackage, name)
      : snapshotFilesystemSkill(
          { boundaryRoot: candidate.boundaryRoot, root: candidate.packageRoot },
          name,
          candidate.source,
        );
  }

  async #discoverCandidate(name: string, candidate: SkillCandidate): Promise<SkillMetadata> {
    return candidate.source === "builtin"
      ? discoverBuiltinSkill(candidate.skillPackage, name)
      : discoverFilesystemSkill(
          { boundaryRoot: candidate.boundaryRoot, root: candidate.packageRoot },
          name,
        );
  }

  #validationError(name: string, candidate: SkillCandidate, error: unknown): SkillValidationError {
    return new SkillValidationError(
      name,
      candidate.source,
      error instanceof Error ? error.message : String(error),
      candidate.source === "builtin" ? undefined : candidate.packageRoot,
      { cause: error },
    );
  }

  #diagnostic(name: string, candidate: SkillCandidate, error: unknown): SkillDiagnostic {
    let message = error instanceof Error ? error.message : String(error);
    if (candidate.source !== "builtin") {
      message = message.replaceAll(candidate.packageRoot, "[skill-package]")
        .replaceAll(candidate.boundaryRoot, "[source-root]");
    }
    message = message.replace(/\/[\w.\-/]+/gu, "[path]").replace(/\s+/gu, " ").trim();
    if (Buffer.byteLength(message, "utf8") > 240) message = "Skill package failed validation";
    return Object.freeze({
      name,
      source: candidate.source,
      code: "SKILL_INVALID_PACKAGE",
      message,
    });
  }

  #sourceLabel(candidate: SkillCandidate): string {
    return candidate.source === "builtin" ? "builtin" : candidate.packageRoot;
  }

  async #listSkillDirs(boundaryRoot: string, root: string): Promise<string[]> {
    try {
      await assertFilesystemSkillAncestry({ boundaryRoot, root });
      const entries = await readdir(root, { withFileTypes: true });
      const names = entries
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name)
        .filter(isSkillName)
        .sort(lexicalCompare);
      await assertFilesystemSkillAncestry({ boundaryRoot, root });
      return names;
    } catch (error) {
      if (isNoEntryError(error)) return [];
      throw new SkillPathError(root, error instanceof Error ? error.message : String(error));
    }
  }
}

async function candidateIsPresent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNoEntryError(error)) return false;
    throw error;
  }
}

function isSkillName(name: string): boolean {
  try {
    assertSkillName(name);
    return true;
  } catch {
    return false;
  }
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isNoEntryError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function lexicalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
