import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod/v4";
import {
  atomicWrite,
  resolveContainedPath,
  SafePathError,
} from "../../utils/safe-file";

export const WorkflowStageSchema = z.enum([
  "idle",
  "product_drafting",
  "critic_prd_review",
  "spec_drafting",
  "critic_spec_review",
  "awaiting_user_approval",
  "foreman_executing",
  "final_review",
  "complete",
  "failed",
]);

export const WorkflowStatusSchema = z.enum(["active", "paused", "completed", "failed"]);

export const WorkflowArtifactKindSchema = z.enum([
  "PRD",
  "SPEC",
  "TASKS",
  "CRITIC_REPORT",
  "EVIDENCE",
  "FINAL_REPORT",
]);

export const WorkflowStateSchema = z.strictObject({
  id: z.string().min(1),
  stage: WorkflowStageSchema,
  status: WorkflowStatusSchema,
  artifacts: z.partialRecord(WorkflowArtifactKindSchema, z.union([z.string(), z.array(z.string())])).default({}),
  agentIds: z.record(z.string(), z.string()).default({}),
  sessionIds: z.record(z.string(), z.string()).default({}),
  taskSessionIds: z.record(z.string(), z.string()).default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
  retryCount: z.number().int().nonnegative().default(0),
  maxRetries: z.number().int().nonnegative().default(3),
  lastError: z.string().optional(),
});

export type WorkflowStage = z.infer<typeof WorkflowStageSchema>;
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

export class WorkflowPathError extends Error {
  constructor(public readonly workflowId: string) {
    super(`Invalid workflow id: ${workflowId}`);
    this.name = "WorkflowPathError";
  }
}

export class WorkflowStateError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly cause: unknown,
  ) {
    super(`Invalid workflow state for ${workflowId}`);
    this.name = "WorkflowStateError";
  }
}

export interface CreateWorkflowStateInput {
  id: string;
  artifacts?: WorkflowState["artifacts"];
  agentIds?: Record<string, string>;
  sessionIds?: Record<string, string>;
  taskSessionIds?: Record<string, string>;
  maxRetries?: number;
  lastError?: string;
}

export interface ListWorkflowsOptions {
  status?: WorkflowStatus | readonly WorkflowStatus[];
}

export class WorkflowStateManager {
  constructor(private readonly workspaceRoot: string) {}

  async create(input: CreateWorkflowStateInput): Promise<WorkflowState> {
    const now = new Date().toISOString();
    const state = WorkflowStateSchema.parse({
      id: input.id,
      stage: "idle",
      status: "active",
      artifacts: input.artifacts ?? {},
      agentIds: input.agentIds ?? {},
      sessionIds: input.sessionIds ?? {},
      taskSessionIds: input.taskSessionIds ?? {},
      createdAt: now,
      updatedAt: now,
      retryCount: 0,
      maxRetries: input.maxRetries ?? 3,
      lastError: input.lastError,
    });

    await this.write(state);
    return state;
  }

  async read(workflowId: string): Promise<WorkflowState> {
    return await this.readWorkflow(workflowId);
  }

  async readWorkflow(workflowId: string): Promise<WorkflowState> {
    const content = await Bun.file(await this.workflowStatePath(workflowId)).text();
    return this.parseWorkflowState(workflowId, content);
  }

  async listWorkflows(options: ListWorkflowsOptions = {}): Promise<WorkflowState[]> {
    const workflowsRoot = resolve(this.workspaceRoot, ".specra", "workflows");
    const allowedStatuses = this.normalizeStatusFilter(options.status);
    const entries = await readdir(workflowsRoot, { withFileTypes: true }).catch((error: unknown) => {
      if (this.isMissingDirectoryError(error)) return [];
      throw error;
    });
    const states: WorkflowState[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const workflowId = entry.name;
      try {
        const state = await this.readWorkflow(workflowId);
        if (allowedStatuses && !allowedStatuses.has(state.status)) continue;
        states.push(state);
      } catch (error) {
        if (error instanceof WorkflowStateError) continue;
        throw error;
      }
    }

    return states.sort((left, right) => left.id.localeCompare(right.id));
  }

  async updateStage(workflowId: string, stage: WorkflowStage): Promise<WorkflowState> {
    const state = await this.read(workflowId);
    const updated = WorkflowStateSchema.parse({ ...state, stage, updatedAt: new Date().toISOString() });
    await this.write(updated);
    return updated;
  }

  async incrementRetryCount(workflowId: string): Promise<WorkflowState> {
    const state = await this.read(workflowId);
    const updated = WorkflowStateSchema.parse({
      ...state,
      retryCount: state.retryCount + 1,
      updatedAt: new Date().toISOString(),
    });
    await this.write(updated);
    return updated;
  }

  async fail(workflowId: string, lastError: string): Promise<WorkflowState> {
    const state = await this.read(workflowId);
    const updated = WorkflowStateSchema.parse({
      ...state,
      stage: "failed",
      status: "failed",
      lastError,
      updatedAt: new Date().toISOString(),
    });
    await this.write(updated);
    return updated;
  }

  async updateStatus(workflowId: string, status: WorkflowStatus): Promise<WorkflowState> {
    const state = await this.read(workflowId);
    const updated = WorkflowStateSchema.parse({ ...state, status, updatedAt: new Date().toISOString() });
    await this.write(updated);
    return updated;
  }

  async updateArtifacts(
    workflowId: string,
    artifacts: WorkflowState["artifacts"],
  ): Promise<WorkflowState> {
    const state = await this.read(workflowId);
    const updated = WorkflowStateSchema.parse({
      ...state,
      artifacts,
      updatedAt: new Date().toISOString(),
    });
    await this.write(updated);
    return updated;
  }

  private async write(state: WorkflowState): Promise<void> {
    const filePath = await this.workflowStatePath(state.id);
    await atomicWrite(filePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  private async workflowStatePath(workflowId: string): Promise<string> {
    const workflowsRoot = resolve(this.workspaceRoot, ".specra", "workflows");
    try {
      return await resolveContainedPath(join(workflowId, "workflow.json"), workflowsRoot);
    } catch (error) {
      if (error instanceof SafePathError) throw new WorkflowPathError(workflowId);
      throw error;
    }
  }

  private parseWorkflowState(workflowId: string, content: string): WorkflowState {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new WorkflowStateError(workflowId, error);
    }

    const result = WorkflowStateSchema.safeParse(parsed);
    if (!result.success) throw new WorkflowStateError(workflowId, result.error);
    return result.data;
  }

  private normalizeStatusFilter(status: ListWorkflowsOptions["status"]): Set<WorkflowStatus> | undefined {
    if (!status) return undefined;
    return new Set(Array.isArray(status) ? status : [status]);
  }

  private isMissingDirectoryError(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}
