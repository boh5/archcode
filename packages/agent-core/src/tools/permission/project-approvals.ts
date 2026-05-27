import { join } from "node:path";
import { z } from "zod";
import { createConsoleLogger, type Logger } from "../../logger";
import { atomicWrite } from "../../utils/safe-file";
import type { PermissionApprovalScope, ShellEffectKind } from "./policy-types";

const SPECRA_DIR = ".specra";
const PERMISSIONS_FILE = "permissions.json";

const ShellEffectKindSchema = z.enum([
  "read",
  "write",
  "delete",
  "network",
  "remote-exec",
  "credential-exfil",
  "system-mutation",
  "protected-specra",
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
  version: z.literal(1),
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
  version: 1,
  approvals: [],
};

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
  return join(workspaceRoot, SPECRA_DIR, PERMISSIONS_FILE);
}

export class ProjectApprovalManager {
  #workspaceRoot: string | null = null;
  #approvalFile: PermissionApprovalFile = cloneApprovalFile(EMPTY_APPROVAL_FILE);
  #writeQueue: Promise<void> = Promise.resolve();
  #fileMtime: number | null = null;

  constructor(private readonly logger: Logger = createConsoleLogger({ module: "project-approvals" })) {}

  async load(workspaceRoot: string): Promise<void> {
    this.#workspaceRoot = workspaceRoot;
    const filePath = approvalsPath(workspaceRoot);
    const file = Bun.file(filePath);

    if (!(await file.exists())) {
      this.#approvalFile = cloneApprovalFile(EMPTY_APPROVAL_FILE);
      this.#fileMtime = null;
      return;
    }

    const fileMtime = file.lastModified;
    try {
      const parsed = PermissionApprovalFileSchema.parse(JSON.parse(await file.text()));
      this.#approvalFile = parsed;
    } catch (error) {
      this.logger.warn("Ignoring malformed project permissions file", {
        context: { path: filePath },
        error,
      });
      this.#approvalFile = cloneApprovalFile(EMPTY_APPROVAL_FILE);
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

    const approval: ProjectApproval = {
      id: crypto.randomUUID(),
      scope,
      display: metadata.display,
      reason: metadata.reason,
      grantedAt: new Date().toISOString(),
      ...(metadata.grantedBy ? { grantedBy: metadata.grantedBy } : {}),
    };

    this.#approvalFile = {
      version: 1,
      approvals: [...this.#approvalFile.approvals, approval],
    };

    await this.#persist();
    return approval;
  }

  listApprovals(): ProjectApproval[] {
    return cloneApprovalFile(this.#approvalFile).approvals;
  }

  async #persist(): Promise<void> {
    const workspaceRoot = this.#workspaceRoot;
    if (workspaceRoot === null) {
      throw new Error("ProjectApprovalManager must be loaded before persisting approvals");
    }

    const snapshot = cloneApprovalFile(this.#approvalFile);
    this.#writeQueue = this.#writeQueue
      .then(() => atomicWrite(approvalsPath(workspaceRoot), serializeApprovalFile(snapshot)))
      .catch((error: unknown) => {
        this.logger.warn?.("Failed to persist permissions file", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    await this.#writeQueue;
  }
}
