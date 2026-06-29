import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { StoreApi } from "zustand";
import { z } from "zod/v4";
import {
  atomicWrite,
  resolveContainedPath,
  SafePathError,
} from "../../utils/safe-file";
import { formatFrontmatter } from "../../utils/frontmatter";
import type { Logger } from "../../logger";
import { silentLogger } from "../../logger";
import type { SessionStoreState } from "../../store/types";
import { buildWorkflowArtifactFrontmatter } from "./artifact-frontmatter";
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

export const WorkflowUuidSchema = z.uuid();
export const WorkflowTitleSchema = z.string().trim().min(1).max(200);

export const StageCompletionRecordSchema = z.strictObject({
  stage: WorkflowStageSchema,
  completedAt: z.string(),
  criticPassed: z.boolean().optional(),
  evidence: z.array(z.string()).optional(),
});

export const DerivedFromSchema = z.strictObject({
  workflowId: WorkflowUuidSchema,
  reason: z.enum(["upgrade", "branch"]),
  handoffSummaryId: z.string().optional(),
  triggeredAt: z.string(),
  triggerMessageId: z.string().optional(),
});

export const DerivedWorkflowEntrySchema = z.strictObject({
  workflowId: WorkflowUuidSchema,
  reason: z.enum(["upgrade", "branch"]),
  createdAt: z.string(),
});

export const WorkflowInteractionStatusSchema = z.enum([
  "proposed",
  "requested",
  "resolved",
  "cancelled",
  "superseded",
]);

export const WorkflowInteractionKindSchema = z.enum([
  "decision",
  "preference",
  "clarification",
  "approval",
]);

export const WorkflowInteractionSchema = z.strictObject({
  id: z.string().trim().min(1),
  decisionKey: z.string().trim().min(1),
  stage: WorkflowStageSchema,
  sourceAgent: z.string().trim().min(1),
  kind: WorkflowInteractionKindSchema,
  question: z.string().trim().min(1),
  options: z.array(z.string()),
  recommendedOption: z.string().optional(),
  rationale: z.string().trim().min(1),
  status: WorkflowInteractionStatusSchema,
  answer: z.string().optional(),
  createdAt: z.string().optional(),
  resolvedAt: z.string().optional(),
  cancelledAt: z.string().optional(),
  supersededBy: z.string().optional(),
  revision: z.number().int().default(1),
}).superRefine((interaction, context) => {
  if (interaction.kind === "decision" && interaction.options.length < 2) {
    context.addIssue({
      code: "custom",
      path: ["options"],
      message: "Decision interactions require at least two options",
    });
  }
});

export const WorkflowStateSchema = z.strictObject({
  id: WorkflowUuidSchema,
  title: WorkflowTitleSchema,
  type: WorkflowTypeSchema,
  stage: WorkflowStageSchema,
  status: WorkflowStatusSchema,
  artifacts: z.partialRecord(WorkflowArtifactKindSchema, z.union([z.string(), z.array(z.string())])).default({}),
  stageCompletions: z.partialRecord(WorkflowStageSchema, StageCompletionRecordSchema).default({}),
  requiredInteractions: z.array(WorkflowInteractionSchema).default([]),
  resolvedInteractions: z.array(WorkflowInteractionSchema).default([]),
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
export type WorkflowArtifactKind = z.infer<typeof WorkflowArtifactKindSchema>;
export type StageCompletionRecord = z.infer<typeof StageCompletionRecordSchema>;
export type DerivedFrom = z.infer<typeof DerivedFromSchema>;
export type DerivedWorkflowEntry = z.infer<typeof DerivedWorkflowEntrySchema>;
export type WorkflowInteractionStatus = z.infer<typeof WorkflowInteractionStatusSchema>;
export type WorkflowInteractionKind = z.infer<typeof WorkflowInteractionKindSchema>;
export type WorkflowInteraction = z.infer<typeof WorkflowInteractionSchema>;
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

export class WorkflowPathError extends Error {
  constructor(public readonly workflowId: string) {
    super(`Invalid workflow id: ${workflowId}`);
    this.name = "WorkflowPathError";
  }
}

export class WorkflowInvalidIdError extends Error {
  constructor(public readonly workflowId: string) {
    super(`Invalid workflow id format: ${workflowId}`);
    this.name = "WorkflowInvalidIdError";
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
  type: WorkflowType;
  title: string;
  artifacts?: WorkflowState["artifacts"];
  derivedFrom?: DerivedFrom;
  sessionIds?: Record<string, string>;
  maxRetries?: number;
  lastError?: string;
}

export interface CreateDerivedWorkflowInput {
  sourceWorkflowId: string;
  title: string;
  targetType: WorkflowType;
  reason: DerivedFrom["reason"];
  triggerMessageId?: string;
  eventStore?: StoreApi<SessionStoreState>;
}

export interface CreateDerivedWorkflowResult {
  source: WorkflowState;
  derived: WorkflowState;
  handoffSummary: string;
  handoffSummaryId: string;
}

export type StageCompletionInput = Omit<StageCompletionRecord, "completedAt">;

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
      id: crypto.randomUUID(),
      title: input.title,
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
    const handoffSummaryId = "HANDOFF_SUMMARY.md";

    const derived = await this.create({
      title: input.title,
      type: input.targetType,
      derivedFrom: {
        workflowId: source.id,
        reason: input.reason,
        handoffSummaryId,
        triggeredAt,
        triggerMessageId: input.triggerMessageId,
      },
    });

    const handoffSummary = buildHandoffSummary({
      source,
      derived,
      reason: input.reason,
      triggerMessageId: input.triggerMessageId,
    });

    const handoffPath = await this.workflowArtifactPath(source.id, handoffSummaryId);
    await atomicWrite(
      handoffPath,
      formatFrontmatter(
        buildWorkflowArtifactFrontmatter(
          { kind: "HANDOFF_SUMMARY", path: handoffSummaryId },
          source,
          {
            writerAgent: "system",
            writerSessionId: source.sessionIds.orchestrator,
            toolCallId: "createDerived",
            writtenAt: triggeredAt,
          },
        ),
        handoffSummary,
      ),
    );

    const sourceUpdated = WorkflowStateSchema.parse({
      ...source,
      artifacts: { ...source.artifacts, HANDOFF_SUMMARY: handoffSummaryId },
      derivedWorkflows: [
        ...source.derivedWorkflows,
        { workflowId: derived.id, reason: input.reason, createdAt: triggeredAt },
      ],
      updatedAt: triggeredAt,
    });
    await this.write(sourceUpdated);

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
    if (!WorkflowUuidSchema.safeParse(workflowId).success) {
      throw new WorkflowInvalidIdError(workflowId);
    }
    const content = await Bun.file(await this.workflowStatePath(workflowId)).text();
    return this.parseWorkflowState(workflowId, content);
  }

  async listWorkflows(options: ListWorkflowsOptions = {}): Promise<WorkflowState[]> {
    const workflowsRoot = resolve(this.workspaceRoot, ".archcode", "workflows");
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
      if (!WorkflowUuidSchema.safeParse(workflowId).success) {
        throw new WorkflowInvalidIdError(workflowId);
      }
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
    record: StageCompletionInput,
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

  async updateLastError(workflowId: string, lastError: string): Promise<WorkflowState> {
    const state = await this.read(workflowId);
    const updated = WorkflowStateSchema.parse({ ...state, lastError, updatedAt: new Date().toISOString() });
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

  async updateInteractions(
    workflowId: string,
    interactions: Pick<WorkflowState, "requiredInteractions" | "resolvedInteractions">,
  ): Promise<WorkflowState> {
    const state = await this.read(workflowId);
    const updated = WorkflowStateSchema.parse({
      ...state,
      requiredInteractions: interactions.requiredInteractions,
      resolvedInteractions: interactions.resolvedInteractions,
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
    const workflowsRoot = resolve(this.workspaceRoot, ".archcode", "workflows");
    try {
      return await resolveContainedPath(join(workflowId, "workflow.json"), workflowsRoot);
    } catch (error) {
      if (error instanceof SafePathError) throw new WorkflowPathError(workflowId);
      throw error;
    }
  }

  private async workflowArtifactPath(workflowId: string, artifactPath: string): Promise<string> {
    const workflowRoot = resolve(this.workspaceRoot, ".archcode", "workflows", workflowId);
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
  derived: WorkflowState;
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
    `# Handoff Summary`,
    "",
    "## Source Workflow",
    `- Workflow ID: ${input.source.id}`,
    `- Title: ${input.source.title}`,
    `- Type: ${input.source.type}`,
    `- Stage: ${input.source.stage}`,
    `- Status: ${input.source.status}`,
    "",
    "## Derived Workflow",
    `- Workflow ID: ${input.derived.id}`,
    `- Title: ${input.derived.title}`,
    `- Type: ${input.derived.type}`,
    "",
    "## Derived Workflow Request",
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
