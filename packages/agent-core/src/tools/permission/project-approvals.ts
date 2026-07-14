import { join } from "node:path";
import { PROJECT_STATE_DIR_NAME } from "@archcode/protocol";
import { z } from "zod";
import type { Logger } from "../../logger";
import { atomicWrite } from "../../utils/safe-file";
import type { PermissionApprovalScope, ShellEffectKind } from "./policy-types";

const PERMISSIONS_FILE = "permissions.json";

const ShellEffectKindSchema = z.enum([
  "read",
  "write",
  "delete",
  "network",
  "remote-exec",
  "credential-exfil",
  "system-mutation",
  "protected-path",
  "parser-uncertain",
  "execute-code",
] satisfies [ShellEffectKind, ...ShellEffectKind[]]);

export const PermissionApprovalScopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tool-operation"),
    toolName: z.string(),
    operation: z.string(),
    target: z.string().optional(),
  }).strict(),
  z.object({
    kind: z.literal("file-path"),
    operation: z.enum(["read", "write", "edit", "delete"]),
    path: z.string(),
    pathMode: z.enum(["exact", "subtree"]),
  }).strict(),
  z.object({
    kind: z.literal("bash-command"),
    command: z.string(),
    subcommands: z.array(z.string()),
    argumentMode: z.enum(["exact", "any"]),
    effects: z.array(ShellEffectKindSchema),
  }).strict(),
  z.object({
    kind: z.literal("bash-exact"),
    normalized: z.string(),
    effects: z.array(ShellEffectKindSchema),
  }).strict(),
  z.object({
    kind: z.literal("web-origin"),
    origin: z.string(),
  }).strict(),
]);

export const PermissionApprovalFileSchema = z.object({
  approvals: z.array(z.object({
    id: z.uuid(),
    scope: PermissionApprovalScopeSchema,
    display: z.string(),
    reason: z.string(),
    grantedAt: z.iso.datetime(),
    grantedBy: z.object({ agentName: z.string().optional(), depth: z.number().int().nonnegative().optional() }).strict().optional(),
  }).strict()),
}).strict();

export type PermissionApprovalFile = z.infer<typeof PermissionApprovalFileSchema>;
export type ProjectApproval = PermissionApprovalFile["approvals"][number];

export interface ProjectApprovalMetadata {
  display: string;
  reason: string;
  grantedBy?: ProjectApproval["grantedBy"];
}

const EMPTY_APPROVAL_FILE: PermissionApprovalFile = {
  approvals: [],
};

export class ProjectApprovalLoadError extends Error {
  constructor(
    public readonly path: string,
    cause: unknown,
  ) {
    super(`Failed to load project approvals from "${path}"`, { cause });
    this.name = "ProjectApprovalLoadError";
  }
}

export class ProjectApprovalPersistError extends Error {
  constructor(
    public readonly path: string,
    cause: unknown,
  ) {
    super(`Failed to persist project approvals to "${path}"`, { cause });
    this.name = "ProjectApprovalPersistError";
  }
}

function cloneApprovalFile(file: PermissionApprovalFile): PermissionApprovalFile {
  return PermissionApprovalFileSchema.parse(structuredClone(file));
}

function serializeApprovalFile(file: PermissionApprovalFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

function scopeKey(scope: PermissionApprovalScope): string {
  return JSON.stringify(scope);
}

function approvalsPath(workspaceRoot: string): string {
  return join(workspaceRoot, PROJECT_STATE_DIR_NAME, PERMISSIONS_FILE);
}

export class ProjectApprovalManager {
  #workspaceRoot: string | null = null;
  #approvalFile: PermissionApprovalFile = cloneApprovalFile(EMPTY_APPROVAL_FILE);
  #writeQueue: Promise<void> = Promise.resolve();
  #fileMtime: number | null = null;

  constructor(_logger: Logger) {}

  async load(workspaceRoot: string): Promise<void> {
    const filePath = approvalsPath(workspaceRoot);
    const file = Bun.file(filePath);

    if (!(await file.exists())) {
      this.#workspaceRoot = workspaceRoot;
      this.#approvalFile = cloneApprovalFile(EMPTY_APPROVAL_FILE);
      this.#fileMtime = null;
      return;
    }

    const fileMtime = file.lastModified;
    try {
      const parsed = PermissionApprovalFileSchema.parse(JSON.parse(await file.text()));
      this.#workspaceRoot = workspaceRoot;
      this.#approvalFile = parsed;
    } catch (error) {
      throw new ProjectApprovalLoadError(filePath, error);
    }
    this.#fileMtime = fileMtime;
  }

  async reloadIfStale(workspaceRoot: string): Promise<void> {
    const file = Bun.file(approvalsPath(workspaceRoot));
    const currentMtime = await file.exists() ? file.lastModified : null;
    if (currentMtime !== this.#fileMtime) {
      await this.load(workspaceRoot);
    }
  }

  hasApproval(scope: PermissionApprovalScope): boolean {
    const key = scopeKey(scope);
    return this.#approvalFile.approvals.some((approval) => scopeKey(approval.scope) === key);
  }

  async addApproval(
    scope: PermissionApprovalScope,
    metadata: ProjectApprovalMetadata,
  ): Promise<ProjectApproval> {
    if (this.#workspaceRoot === null) {
      throw new Error("ProjectApprovalManager must be loaded before adding approvals");
    }

    const existing = this.#approvalFile.approvals.find(
      (approval) => scopeKey(approval.scope) === scopeKey(scope),
    );
    if (existing) return existing;

    const workspaceRoot = this.#workspaceRoot;
    const operation = this.#writeQueue.then(async () => {
      const queuedExisting = this.#approvalFile.approvals.find(
        (approval) => scopeKey(approval.scope) === scopeKey(scope),
      );
      if (queuedExisting) return queuedExisting;

      const approval: ProjectApproval = {
        id: crypto.randomUUID(),
        scope,
        display: metadata.display,
        reason: metadata.reason,
        grantedAt: new Date().toISOString(),
        ...(metadata.grantedBy ? { grantedBy: metadata.grantedBy } : {}),
      };
      const snapshot: PermissionApprovalFile = {
        approvals: [...this.#approvalFile.approvals, approval],
      };
      const filePath = approvalsPath(workspaceRoot);
      try {
        await atomicWrite(filePath, serializeApprovalFile(snapshot));
      } catch (error) {
        throw new ProjectApprovalPersistError(filePath, error);
      }

      this.#approvalFile = snapshot;
      this.#fileMtime = Bun.file(filePath).lastModified;
      return approval;
    });

    // Keep the serialization barrier usable after a failed write while the
    // caller still observes the original rejected operation below.
    this.#writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  listApprovals(): ProjectApproval[] {
    return cloneApprovalFile(this.#approvalFile).approvals;
  }
}
