import {
  constants,
  type Stats,
} from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  RuntimeDataDeleteResult,
  RuntimeDataInspectionResponse,
  RuntimeDataIssue,
  RuntimeDataProjectInspection,
  RuntimeDataSchemaIssue,
  RuntimeDataStats,
} from "@archcode/protocol";

import { AutomationStateFileSchema } from "../automations/schema";
import { HitlBoundaryCodec } from "../hitl/boundary-codec";
import type { ProjectInfo } from "../projects/types";
import { projectRuntimePath } from "../projects/runtime-path";
import { SecretRedactionPolicy } from "../security";
import { SessionFileSchema } from "../store/helpers";
import { ProjectTodoStateFileSchema } from "../todos/schema";
import { PermissionApprovalFileSchema } from "../tools/permission/project-approvals";

const SCHEMA_ISSUE_MESSAGE = "Does not match the current ArchCode data format.";
const MAX_SCHEMA_ISSUES_PER_FILE = 20;
const MAX_SCHEMA_ISSUE_PATH_SEGMENTS = 12;
const SCHEMA_ISSUE_FIELD_SEGMENT = "$field";

export type RuntimeDataRequestErrorCode =
  | "EMPTY_PROJECT_SLUGS"
  | "DUPLICATE_PROJECT_SLUG"
  | "PROJECT_NOT_REGISTERED"
  | "PROJECT_HAS_NO_ISSUES"
  | "DELETE_TARGET_UNSAFE";

export interface RuntimeDataProjectRegistry {
  list(): Promise<ProjectInfo[]>;
}

export interface RuntimeDataServiceOptions {
  readonly projectRegistry: RuntimeDataProjectRegistry;
}

export class RuntimeDataRequestError extends Error {
  constructor(
    public readonly code: RuntimeDataRequestErrorCode,
    message: string,
    public readonly projectSlug?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeDataRequestError";
  }
}

/** Narrow current-schema inspection and whole-project Runtime deletion service. */
export class RuntimeDataService {
  readonly #projectRegistry: RuntimeDataProjectRegistry;
  readonly #hitlCodec = new HitlBoundaryCodec(new SecretRedactionPolicy([]));

  constructor(options: RuntimeDataServiceOptions) {
    this.#projectRegistry = options.projectRegistry;
  }

  async inspect(): Promise<RuntimeDataInspectionResponse> {
    const projects = await this.#projectRegistry.list();
    return {
      projects: await Promise.all(projects.map(async (project) => await this.#inspectProject(project))),
    };
  }

  async delete(projectSlugs: readonly string[]): Promise<RuntimeDataDeleteResult> {
    assertProjectSlugs(projectSlugs);

    const registeredProjects = await this.#projectRegistry.list();
    const projectsBySlug = new Map(registeredProjects.map((project) => [project.slug, project]));
    const projects = projectSlugs.map((projectSlug) => {
      const project = projectsBySlug.get(projectSlug);
      if (project === undefined) {
        throw new RuntimeDataRequestError(
          "PROJECT_NOT_REGISTERED",
          "Runtime data can only be deleted for a registered project.",
          projectSlug,
        );
      }
      return project;
    });

    // Complete every rejection and filesystem-safety check before deleting any
    // selected project. A bad item therefore cannot partially authorize a batch.
    for (const project of projects) {
      const inspection = await this.#inspectProject(project);
      if (inspection.issues.length === 0) {
        throw new RuntimeDataRequestError(
          "PROJECT_HAS_NO_ISSUES",
          "Runtime data can only be deleted for a project with detected issues.",
          project.slug,
        );
      }
      if (inspection.issues.some((issue) => issue.reason === "unreadable")) {
        throw new RuntimeDataRequestError(
          "DELETE_TARGET_UNSAFE",
          "The project Runtime tree is not safe to delete.",
          project.slug,
        );
      }
      await assertSafeDeletionTarget(project);
    }

    const results = [] as RuntimeDataDeleteResult["results"][number][];
    for (const project of projects) {
      try {
        const currentInspection = await this.#inspectProject(project);
        if (currentInspection.issues.length === 0
          || currentInspection.issues.some((issue) => issue.reason === "unreadable")) {
          throw unsafeDeletionTarget(project.slug);
        }
        await assertSafeDeletionTarget(project);
        const runtimePath = projectRuntimePath(project.workspaceRoot);
        await rm(runtimePath, { recursive: true, force: false, maxRetries: 0 });
        if (await lstatIfPresent(runtimePath) !== undefined) {
          throw new Error("Runtime path still exists after deletion");
        }
        results.push({ projectSlug: project.slug, status: "deleted" });
      } catch {
        results.push({
          projectSlug: project.slug,
          status: "error",
          error: {
            code: "delete_failed",
            message: "Runtime data could not be deleted.",
          },
        });
      }
    }

    return { results };
  }

  async #inspectProject(project: ProjectInfo): Promise<RuntimeDataProjectInspection> {
    const runtimePath = projectRuntimePath(project.workspaceRoot);
    const issues: RuntimeDataIssue[] = [];
    const issueKeys = new Set<string>();
    const addIssue = (issue: RuntimeDataIssue): void => {
      const key = `${issue.reason}\0${issue.relativePath}`;
      if (issueKeys.has(key)) return;
      issueKeys.add(key);
      issues.push(issue);
    };

    let stats: RuntimeDataStats = { fileCount: 0, totalBytes: 0 };
    try {
      if (!await isInspectableRuntimeRoot(project.workspaceRoot, runtimePath, addIssue)) {
        return projectInspection(project, runtimePath, stats, issues);
      }
      stats = await scanRuntimeTree(runtimePath, addIssue);
      await this.#inspectSessions(runtimePath, addIssue);
      await inspectJsonFile(
        runtimePath,
        "todos/state.json",
        (value) => ProjectTodoStateFileSchema.parse(value),
        addIssue,
      );
      await inspectJsonFile(
        runtimePath,
        "automations/state.json",
        (value) => AutomationStateFileSchema.parse(value),
        addIssue,
      );
      await inspectJsonFile(
        runtimePath,
        "hitl-queue.json",
        (value) => this.#hitlCodec.parseProjectFile(value),
        addIssue,
      );
      await inspectJsonFile(
        runtimePath,
        "permissions.json",
        (value) => PermissionApprovalFileSchema.parse(value),
        addIssue,
      );
    } catch {
      addIssue({ relativePath: ".", reason: "unreadable" });
    }

    return projectInspection(project, runtimePath, stats, issues);
  }

  async #inspectSessions(
    runtimePath: string,
    addIssue: (issue: RuntimeDataIssue) => void,
  ): Promise<void> {
    const sessionsPath = join(runtimePath, "sessions");
    const sessionsStat = await inspectDirectory(sessionsPath, "sessions", addIssue);
    if (sessionsStat === undefined) return;

    let sessionNames: string[];
    try {
      sessionNames = await readdir(sessionsPath);
    } catch {
      addIssue({ relativePath: "sessions", reason: "unreadable" });
      return;
    }

    for (const sessionName of sessionNames.sort()) {
      const sessionRelativePath = joinRelative("sessions", sessionName);
      const sessionPath = join(sessionsPath, sessionName);
      const sessionStat = await lstatForInspection(sessionPath, sessionRelativePath, addIssue);
      if (sessionStat === undefined) continue;
      if (sessionStat.isSymbolicLink() || !sessionStat.isDirectory()) {
        addIssue({ relativePath: sessionRelativePath, reason: "unreadable" });
        continue;
      }
      await inspectJsonFile(
        runtimePath,
        joinRelative(sessionRelativePath, "session.json"),
        (value) => SessionFileSchema.parse(value),
        addIssue,
        true,
      );
    }
  }
}

function assertProjectSlugs(projectSlugs: readonly string[]): void {
  if (projectSlugs.length === 0) {
    throw new RuntimeDataRequestError(
      "EMPTY_PROJECT_SLUGS",
      "At least one project slug is required.",
    );
  }
  const unique = new Set(projectSlugs);
  if (unique.size !== projectSlugs.length) {
    throw new RuntimeDataRequestError(
      "DUPLICATE_PROJECT_SLUG",
      "Project slugs must not contain duplicates.",
    );
  }
}

async function scanRuntimeTree(
  runtimePath: string,
  addIssue: (issue: RuntimeDataIssue) => void,
): Promise<RuntimeDataStats> {
  const stats = { fileCount: 0, totalBytes: 0 };
  const rootStat = await lstatForInspection(runtimePath, ".", addIssue);
  if (rootStat === undefined) return stats;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    addIssue({ relativePath: ".", reason: "unreadable" });
    return stats;
  }

  const directories = [runtimePath];
  while (directories.length > 0) {
    const directoryPath = directories.pop()!;
    const directoryRelativePath = toRuntimeRelativePath(runtimePath, directoryPath);
    let names: string[];
    try {
      names = await readdir(directoryPath);
    } catch {
      addIssue({ relativePath: directoryRelativePath, reason: "unreadable" });
      continue;
    }

    for (const name of names.sort().reverse()) {
      const entryPath = join(directoryPath, name);
      const entryRelativePath = toRuntimeRelativePath(runtimePath, entryPath);
      const entryStat = await lstatForInspection(entryPath, entryRelativePath, addIssue);
      if (entryStat === undefined) continue;
      if (entryStat.isSymbolicLink()) {
        addIssue({ relativePath: entryRelativePath, reason: "unreadable" });
      } else if (entryStat.isDirectory()) {
        directories.push(entryPath);
      } else if (entryStat.isFile()) {
        stats.fileCount += 1;
        stats.totalBytes += entryStat.size;
      } else {
        addIssue({ relativePath: entryRelativePath, reason: "unreadable" });
      }
    }
  }
  return stats;
}

async function inspectDirectory(
  path: string,
  relativePath: string,
  addIssue: (issue: RuntimeDataIssue) => void,
): Promise<Stats | undefined> {
  const stat = await lstatForInspection(path, relativePath, addIssue);
  if (stat === undefined) return undefined;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    addIssue({ relativePath, reason: "unreadable" });
    return undefined;
  }
  return stat;
}

async function lstatForInspection(
  path: string,
  relativePath: string,
  addIssue: (issue: RuntimeDataIssue) => void,
): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    addIssue({ relativePath, reason: "unreadable" });
    return undefined;
  }
}

async function inspectJsonFile(
  runtimePath: string,
  relativePath: string,
  parseCurrentSchema: (value: unknown) => unknown,
  addIssue: (issue: RuntimeDataIssue) => void,
  missingIsUnreadable = false,
): Promise<void> {
  const path = join(runtimePath, relativePath);
  const stat = await lstatForInspection(path, relativePath, addIssue);
  if (stat === undefined) {
    if (missingIsUnreadable) addIssue({ relativePath, reason: "unreadable" });
    return;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    addIssue({ relativePath, reason: "unreadable" });
    return;
  }

  let text: string;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile()) {
        addIssue({ relativePath, reason: "unreadable" });
        return;
      }
      text = await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
  } catch {
    addIssue({ relativePath, reason: "unreadable" });
    return;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    addIssue({ relativePath, reason: "invalid_json" });
    return;
  }

  try {
    parseCurrentSchema(value);
  } catch (error) {
    addIssue({
      relativePath,
      reason: "invalid_current_schema",
      schemaIssues: sanitizeSchemaIssues(error),
    });
  }
}

function sanitizeSchemaIssues(error: unknown): RuntimeDataSchemaIssue[] {
  const issues = isRecord(error) && Array.isArray(error.issues) ? error.issues : [];
  const sanitized = new Map<string, RuntimeDataSchemaIssue>();
  for (const issue of issues) {
    const rawPath = isRecord(issue) && Array.isArray(issue.path) ? issue.path : [];
    const next = {
      path: rawPath
        .slice(0, MAX_SCHEMA_ISSUE_PATH_SEGMENTS)
        .map((part) => typeof part === "number" ? part : SCHEMA_ISSUE_FIELD_SEGMENT),
      message: SCHEMA_ISSUE_MESSAGE,
    };
    sanitized.set(JSON.stringify(next.path), next);
    if (sanitized.size >= MAX_SCHEMA_ISSUES_PER_FILE) break;
  }
  return sanitized.size > 0
    ? [...sanitized.values()]
    : [{ path: [], message: SCHEMA_ISSUE_MESSAGE }];
}

async function isInspectableRuntimeRoot(
  workspacePath: string,
  runtimePath: string,
  addIssue: (issue: RuntimeDataIssue) => void,
): Promise<boolean> {
  const workspaceState = await inspectAncestorDirectory(workspacePath, false);
  if (workspaceState !== "directory") {
    addIssue({ relativePath: ".", reason: "unreadable" });
    return false;
  }

  const statePath = dirname(runtimePath);
  const stateState = await inspectAncestorDirectory(statePath, true);
  if (stateState === "missing") return false;
  if (stateState !== "directory") {
    addIssue({ relativePath: ".", reason: "unreadable" });
    return false;
  }

  const runtimeState = await inspectAncestorDirectory(runtimePath, true);
  if (runtimeState === "missing") return false;
  if (runtimeState !== "directory") {
    addIssue({ relativePath: ".", reason: "unreadable" });
    return false;
  }
  return true;
}

async function inspectAncestorDirectory(
  path: string,
  missingIsEmpty: boolean,
): Promise<"directory" | "missing" | "unsafe"> {
  try {
    const stat = await lstat(path);
    return !stat.isSymbolicLink() && stat.isDirectory() ? "directory" : "unsafe";
  } catch (error) {
    if (missingIsEmpty && isMissingPathError(error)) return "missing";
    return "unsafe";
  }
}

function projectInspection(
  project: ProjectInfo,
  runtimePath: string,
  stats: RuntimeDataStats,
  issues: RuntimeDataIssue[],
): RuntimeDataProjectInspection {
  return {
    projectSlug: project.slug,
    name: project.name,
    workspace: project.workspaceRoot,
    runtimePath,
    stats,
    issues: issues.sort(compareIssues),
  };
}

async function assertSafeDeletionTarget(project: ProjectInfo): Promise<void> {
  const workspacePath = project.workspaceRoot;
  const normalizedWorkspacePath = resolve(workspacePath);
  const runtimePath = projectRuntimePath(workspacePath);
  const statePath = dirname(runtimePath);
  const normalizedStatePath = join(normalizedWorkspacePath, ".archcode");
  const normalizedRuntimePath = join(normalizedStatePath, "runtime");

  if (!isAbsolute(workspacePath)
    || normalizedWorkspacePath !== workspacePath
    || resolve(statePath) !== normalizedStatePath
    || resolve(runtimePath) !== normalizedRuntimePath
    || !isPathWithin(normalizedWorkspacePath, normalizedStatePath)
    || !isPathWithin(normalizedStatePath, normalizedRuntimePath)) {
    throw unsafeDeletionTarget(project.slug);
  }

  const workspaceStat = await requirePlainDirectory(workspacePath, project.slug);
  const stateStat = await requirePlainDirectory(statePath, project.slug);
  const runtimeStat = await requirePlainDirectory(runtimePath, project.slug);
  if (!workspaceStat.isDirectory() || !stateStat.isDirectory() || !runtimeStat.isDirectory()) {
    throw unsafeDeletionTarget(project.slug);
  }

  let realWorkspace: string;
  let realState: string;
  let realRuntime: string;
  try {
    [realWorkspace, realState, realRuntime] = await Promise.all([
      realpath(workspacePath),
      realpath(statePath),
      realpath(runtimePath),
    ]);
  } catch (error) {
    throw unsafeDeletionTarget(project.slug, error);
  }
  if (realState !== join(realWorkspace, ".archcode")
    || realRuntime !== join(realState, "runtime")
    || !isPathWithin(realWorkspace, realState)
    || !isPathWithin(realState, realRuntime)) {
    throw unsafeDeletionTarget(project.slug);
  }

  await assertPlainRuntimeTree(runtimePath, project.slug);
}

async function assertPlainRuntimeTree(runtimePath: string, projectSlug: string): Promise<void> {
  const directories = [runtimePath];
  while (directories.length > 0) {
    const directoryPath = directories.pop()!;
    let names: string[];
    try {
      names = await readdir(directoryPath);
    } catch (error) {
      throw unsafeDeletionTarget(projectSlug, error);
    }
    for (const name of names) {
      const entryPath = join(directoryPath, name);
      let stat: Stats;
      try {
        stat = await lstat(entryPath);
      } catch (error) {
        throw unsafeDeletionTarget(projectSlug, error);
      }
      if (stat.isSymbolicLink()) throw unsafeDeletionTarget(projectSlug);
      if (stat.isDirectory()) {
        directories.push(entryPath);
      } else if (!stat.isFile()) {
        throw unsafeDeletionTarget(projectSlug);
      }
    }
  }
}

async function requirePlainDirectory(path: string, projectSlug: string): Promise<Stats> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafeDeletionTarget(projectSlug);
    return stat;
  } catch (error) {
    if (error instanceof RuntimeDataRequestError) throw error;
    throw unsafeDeletionTarget(projectSlug, error);
  }
}

function unsafeDeletionTarget(projectSlug: string, cause?: unknown): RuntimeDataRequestError {
  return new RuntimeDataRequestError(
    "DELETE_TARGET_UNSAFE",
    "The project Runtime tree is not safe to delete.",
    projectSlug,
    cause === undefined ? undefined : { cause },
  );
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isPathWithin(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent !== ""
    && pathFromParent !== ".."
    && !pathFromParent.startsWith(`..${sep}`)
    && !isAbsolute(pathFromParent);
}

function toRuntimeRelativePath(runtimePath: string, path: string): string {
  const value = relative(runtimePath, path);
  return value === "" ? "." : value.split(sep).join("/");
}

function joinRelative(...parts: string[]): string {
  return parts.join("/");
}

function compareIssues(left: RuntimeDataIssue, right: RuntimeDataIssue): number {
  return left.relativePath.localeCompare(right.relativePath) || left.reason.localeCompare(right.reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
