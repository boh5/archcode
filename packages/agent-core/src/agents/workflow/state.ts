import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { StoreApi } from "zustand";
import { z } from "zod/v4";
import {
  atomicWrite,
  resolveContainedPath,
  SafePathError,
} from "../../utils/safe-file";
import type { Logger } from "../../logger";
import { silentLogger } from "../../logger";
import type { SessionStoreState } from "../../store/types";
import { emitWorkflowStateChange } from "./events";

export const WorkflowStageSchema = z.enum([
  "idle",
  "researching",
  "research_consolidation",
  "quick_analysis",
  "quick_patch",
  "quick_verify",
  "product_drafting",
  "critic_prd_review",
  "spec_drafting",
  "critic_spec_review",
  "awaiting_user_approval",
  "foreman_executing",
  "final_review",
]);

export const WorkflowTypeSchema = z.enum(["research_only", "quick_fix", "full_feature"]);

export const WorkflowStatusSchema = z.enum(["active", "paused", "completed", "failed"]);

export const WorkflowArtifactKindSchema = z.enum([
  "RESEARCH",
  "PRD",
  "SPEC",
  "TASKS",
  "HANDOFF_SUMMARY",
  "INTERACTIONS",
  "CRITIC_REPORT",
  "EVIDENCE",
  "FINAL_REPORT",
]);

export const StageCompletionRecordSchema = z.strictObject({
  stage: WorkflowStageSchema,
  completedAt: z.string(),
  criticPassed: z.boolean().optional(),
  evidence: z.array(z.string()).optional(),
});

export const DerivedFromSchema = z.strictObject({
  workflowId: z.string().min(1),
  reason: z.enum(["upgrade", "branch"]),
  handoffSummaryId: z.string().optional(),
  triggeredAt: z.string(),
  triggerMessageId: z.string().optional(),
});

export const DerivedWorkflowEntrySchema = z.strictObject({
  workflowId: z.string().min(1),
  reason: z.enum(["upgrade", "branch"]),
  createdAt: z.string(),
});

export const WorkflowStateSchema = z.strictObject({
  id: z.string().min(1),
  type: WorkflowTypeSchema,
  stage: WorkflowStageSchema,
  status: WorkflowStatusSchema,
  artifacts: z.partialRecord(WorkflowArtifactKindSchema, z.union([z.string(), z.array(z.string())])).default({}),
  stageCompletions: z.partialRecord(WorkflowStageSchema, StageCompletionRecordSchema).default({}),
  derivedFrom: DerivedFromSchema.optional(),
  derivedWorkflows: z.array(DerivedWorkflowEntrySchema).default([]),
  sessionIds: z.record(z.string(), z.string()).default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
  retryCount: z.number().int().nonnegative().default(0),
  maxRetries: z.number().int().nonnegative().default(3),
  lastError: z.string().optional(),
});

export type WorkflowStage = z.infer<typeof WorkflowStageSchema>;
export type WorkflowType = z.infer<typeof WorkflowTypeSchema>;
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;
export type StageCompletionRecord = z.infer<typeof StageCompletionRecordSchema>;
export type DerivedFrom = z.infer<typeof DerivedFromSchema>;
export type DerivedWorkflowEntry = z.infer<typeof DerivedWorkflowEntrySchema>;
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
  type: WorkflowType;
  artifacts?: WorkflowState["artifacts"];
  derivedFrom?: DerivedFrom;
  sessionIds?: Record<string, string>;
  maxRetries?: number;
  lastError?: string;
}

export interface CreateDerivedWorkflowInput {
  sourceWorkflowId: string;
  targetType: WorkflowType;
  reason: DerivedFrom["reason"];
  triggerMessageId?: string;
  id?: string;
  eventStore?: StoreApi<SessionStoreState>;
}

export interface CreateDerivedWorkflowResult {
  source: WorkflowState;
  derived: WorkflowState;
  handoffSummary: string;
  handoffSummaryId: string;
}

export interface ListWorkflowsOptions {
  status?: WorkflowStatus | readonly WorkflowStatus[];
}

export class WorkflowStateManager {
  readonly #logger: Logger;

  constructor(
    private readonly workspaceRoot: string,
    logger: Logger = silentLogger,
  ) {
    this.#logger = logger.child({ module: "workflow.state" });
  }

  async create(input: CreateWorkflowStateInput): Promise<WorkflowState> {
    const now = new Date().toISOString();
    const state = WorkflowStateSchema.parse({
      id: input.id,
      type: input.type,
      stage: "idle",
      status: "active",
      artifacts: input.artifacts ?? {},
      stageCompletions: {},
      derivedFrom: input.derivedFrom,
      derivedWorkflows: [],
      sessionIds: input.sessionIds ?? {},
      createdAt: now,
      updatedAt: now,
      retryCount: 0,
      maxRetries: input.maxRetries ?? 3,
      lastError: input.lastError,
    });

    await this.write(state);
    return state;
  }

  async createDerived(input: CreateDerivedWorkflowInput): Promise<CreateDerivedWorkflowResult> {
    const source = await this.read(input.sourceWorkflowId);
    if (source.status === "completed" || source.status === "failed") {
      throw new WorkflowTerminalStateError(source.id, source.status);
    }

    const triggeredAt = new Date().toISOString();
    const derivedWorkflowId = input.id ?? crypto.randomUUID();
    const handoffSummaryId = "HANDOFF_SUMMARY.md";
    const handoffSummary = buildHandoffSummary({
      source,
      targetType: input.targetType,
      reason: input.reason,
      triggerMessageId: input.triggerMessageId,
    });

    const handoffPath = await this.workflowArtifactPath(source.id, handoffSummaryId);
    await atomicWrite(handoffPath, handoffSummary);

    const sourceUpdated = WorkflowStateSchema.parse({
      ...source,
      artifacts: { ...source.artifacts, HANDOFF_SUMMARY: handoffSummaryId },
      derivedWorkflows: [
        ...source.derivedWorkflows,
        { workflowId: derivedWorkflowId, reason: input.reason, createdAt: triggeredAt },
      ],
      updatedAt: triggeredAt,
    });
    await this.write(sourceUpdated);

    const derived = await this.create({
      id: derivedWorkflowId,
      type: input.targetType,
      derivedFrom: {
        workflowId: source.id,
        reason: input.reason,
        handoffSummaryId,
        triggeredAt,
        triggerMessageId: input.triggerMessageId,
      },
    });

    if (input.eventStore) {
      emitWorkflowStateChange(input.eventStore, sourceUpdated.id, ["artifacts", "derivedWorkflows"]);
      emitWorkflowStateChange(input.eventStore, derived.id, ["stage", "status", "derivedFrom"]);
    }

    return { source: sourceUpdated, derived, handoffSummary, handoffSummaryId };
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
      this.#logger.warn("workflow.list.readdir.failed", {
        error: logError(error),
      });
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
        if (error instanceof WorkflowStateError) {
          this.#logger.debug("workflow.list.parse.skipped", {
            context: { path: join(workflowsRoot, workflowId, "workflow.json") },
            error: logError(error),
          });
          continue;
        }
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

  async recordStageCompletion(
    workflowId: string,
    record: Omit<StageCompletionRecord, "completedAt">,
  ): Promise<WorkflowState> {
    const state = await this.read(workflowId);
    const completion: StageCompletionRecord = {
      ...record,
      completedAt: new Date().toISOString(),
    };
    const updated = WorkflowStateSchema.parse({
      ...state,
      stageCompletions: { ...state.stageCompletions, [record.stage]: completion },
      updatedAt: new Date().toISOString(),
    });
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
      status: "failed",
      lastError,
      updatedAt: new Date().toISOString(),
    });
    await this.write(updated);
    return updated;
  }

  async complete(workflowId: string): Promise<WorkflowState> {
    const state = await this.read(workflowId);
    const updated = WorkflowStateSchema.parse({
      ...state,
      status: "completed",
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

  async updateSessionIds(workflowId: string, sessionIds: Record<string, string>): Promise<WorkflowState> {
    const state = await this.read(workflowId);
    const updated = WorkflowStateSchema.parse({
      ...state,
      sessionIds,
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

  private async workflowArtifactPath(workflowId: string, artifactPath: string): Promise<string> {
    const workflowRoot = resolve(this.workspaceRoot, ".specra", "workflows", workflowId);
    try {
      return await resolveContainedPath(artifactPath, workflowRoot);
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

export class WorkflowTerminalStateError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly status: WorkflowStatus,
  ) {
    super(`Cannot derive workflow from terminal workflow ${workflowId} with status ${status}`);
    this.name = "WorkflowTerminalStateError";
  }
}

function buildHandoffSummary(input: {
  source: WorkflowState;
  targetType: WorkflowType;
  reason: DerivedFrom["reason"];
  triggerMessageId?: string;
}): string {
  const artifactLines = Object.entries(input.source.artifacts)
    .flatMap(([kind, value]) => {
      const paths = Array.isArray(value) ? value : [value];
      return paths.map((path) => `- ${kind}: ${path}`);
    });
  const triggerLine = input.triggerMessageId
    ? `- Trigger message ID: ${input.triggerMessageId}`
    : "- Trigger message ID: _not provided_";

  return [
    `# Handoff Summary for ${input.source.id}`,
    "",
    "## Source Workflow",
    `- Workflow ID: ${input.source.id}`,
    `- Type: ${input.source.type}`,
    `- Stage: ${input.source.stage}`,
    `- Status: ${input.source.status}`,
    "",
    "## Derived Workflow Request",
    `- Target type: ${input.targetType}`,
    `- Reason: ${input.reason}`,
    triggerLine,
    "",
    "## Key Artifacts Available",
    ...(artifactLines.length > 0 ? artifactLines : ["- _No artifacts recorded yet._"]),
    "",
    "## Instructions for Derived Orchestrator",
    "- Read referenced artifacts with artifact_read before delegating child agents.",
    "- Treat this summary as context, not as copied workflow state.",
    "- Start from idle with a fresh workflow/session and choose the next transition explicitly.",
    "",
  ].join("\n");
}

function logError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name || "Error", message: error.message };
  }

  return { name: typeof error, message: String(error) };
}
