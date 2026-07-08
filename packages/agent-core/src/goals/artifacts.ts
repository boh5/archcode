import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type {
  GoalArtifactFile,
  GoalArtifactName,
  GoalPhase,
  GoalState,
} from "@archcode/protocol";
import { PROJECT_STATE_DIR_NAME } from "@archcode/protocol";

import { containsSecretPattern } from "../security/patterns";
import { atomicWrite, resolveContainedPath, SafePathError } from "../utils/safe-file";
import { GoalArtifactNameSchema, GoalUuidSchema } from "./state";

export type GoalArtifactOwner = Pick<GoalState, "id" | "phase">;

export interface WriteGoalArtifactOptions {
  /** Agent role writing the artifact. plan.md is restricted to the Plan Agent. */
  agentName: string;
}

export class GoalArtifactNameError extends Error {
  constructor(public readonly name: string) {
    super(`Invalid goal artifact name: ${name}`);
    this.name = "GoalArtifactNameError";
  }
}

export class GoalArtifactPathError extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`Invalid goal artifact path: ${reason} (path: "${path}")`);
    this.name = "GoalArtifactPathError";
  }
}

export class GoalArtifactPlanLockedError extends Error {
  constructor(
    public readonly goalId: string,
    public readonly phase: GoalPhase,
    public readonly agentName: string,
  ) {
    super("plan.md can only be written by the Plan Agent during the plan phase");
    this.name = "GoalArtifactPlanLockedError";
  }
}

export class GoalArtifactSecretError extends Error {
  constructor(public readonly patterns: string[]) {
    super(`Goal artifact content contains potential secrets: ${patterns.join(", ")}`);
    this.name = "GoalArtifactSecretError";
  }
}

export class GoalArtifactManager {
  constructor(public readonly workspaceRoot: string) {}

  async writeArtifact(
    goal: GoalArtifactOwner,
    name: GoalArtifactName,
    content: string,
    options: WriteGoalArtifactOptions,
  ): Promise<GoalArtifactFile> {
    const safeName = this.parseArtifactName(name);
    this.assertPlanWriteAllowed(goal, safeName, options.agentName);
    this.assertNoSecrets(content);

    const filePath = await this.artifactPath(goal.id, safeName);
    await atomicWrite(filePath, normalizeMarkdown(content));
    return await this.describeArtifact(goal.id, safeName);
  }

  async readArtifact(goalId: string, name: GoalArtifactName): Promise<string | null> {
    const safeName = this.parseArtifactName(name);
    const filePath = await this.artifactPath(goalId, safeName);
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    return await file.text();
  }

  async listArtifacts(goalId: string): Promise<GoalArtifactFile[]> {
    const dir = await this.artifactsRoot(goalId);
    const existing = new Set<string>();
    try {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isFile()) existing.add(entry.name);
      }
    } catch (error) {
      if (isMissingDirectoryError(error)) return [];
      throw error;
    }

    const files: GoalArtifactFile[] = [];
    for (const name of CANONICAL_ARTIFACT_NAMES) {
      if (existing.has(name)) files.push(await this.describeArtifact(goalId, name));
    }
    return files;
  }

  async resolveArtifactPathForTest(goalId: string, name: string): Promise<string> {
    const safeName = this.parseArtifactName(name);
    return await this.artifactPath(goalId, safeName);
  }

  private parseArtifactName(name: string): GoalArtifactName {
    const parsed = GoalArtifactNameSchema.safeParse(name);
    if (!parsed.success) throw new GoalArtifactNameError(name);
    return parsed.data;
  }

  private assertPlanWriteAllowed(
    goal: GoalArtifactOwner,
    name: GoalArtifactName,
    agentName: string,
  ): void {
    if (name !== "plan.md") return;
    if (goal.phase === "plan" && agentName === "plan") return;
    throw new GoalArtifactPlanLockedError(goal.id, goal.phase, agentName);
  }

  private assertNoSecrets(content: string): void {
    const secretCheck = containsSecretPattern(content);
    if (secretCheck.found) throw new GoalArtifactSecretError(secretCheck.patterns);
  }

  private async describeArtifact(goalId: string, name: GoalArtifactName): Promise<GoalArtifactFile> {
    const filePath = await this.artifactPath(goalId, name);
    const file = Bun.file(filePath);
    const content = await file.text();
    const stats = await file.stat();
    return {
      name,
      path: relative(this.workspaceRoot, filePath),
      mediaType: "text/markdown",
      updatedAt: stats.mtime.toISOString(),
      sizeBytes: stats.size,
      sha256: await sha256Hex(content),
    };
  }

  private async artifactPath(goalId: string, name: GoalArtifactName): Promise<string> {
    const parsedGoalId = GoalUuidSchema.safeParse(goalId);
    if (!parsedGoalId.success) throw new GoalArtifactPathError(goalId, "Goal id must be a UUID");

    try {
      return await resolveContainedPath(
        join(parsedGoalId.data, "artifacts", name),
        this.goalsRoot(),
      );
    } catch (error) {
      if (error instanceof SafePathError) throw new GoalArtifactPathError(error.path, error.reason);
      throw error;
    }
  }

  private async artifactsRoot(goalId: string): Promise<string> {
    const parsedGoalId = GoalUuidSchema.safeParse(goalId);
    if (!parsedGoalId.success) throw new GoalArtifactPathError(goalId, "Goal id must be a UUID");
    return resolve(this.goalsRoot(), parsedGoalId.data, "artifacts");
  }

  private goalsRoot(): string {
    return resolve(this.workspaceRoot, PROJECT_STATE_DIR_NAME, "goals");
  }
}

export const CANONICAL_ARTIFACT_NAMES = GoalArtifactNameSchema.options;

function normalizeMarkdown(content: string): string {
  return `${content.trimEnd()}\n`;
}

async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isMissingDirectoryError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
