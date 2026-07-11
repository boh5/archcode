export type {
  Project,
  DirectoryEntry,
  DirectoryListResponse,
  DirectorySearchResponse,
  SessionSummary,
  Session,
  SessionTreeResponse,
  SessionTreeNode,
  SessionTreeDiagnostic,
  SessionTreeDiagnosticType,
  SessionPart,
  SessionMessage,
  SessionStep,
  SessionTodo,
  GoalState,
  GoalStatus,
  GoalBlockerKind,
  GoalEvidenceRefKind,
  GoalEvidenceRef,
  GoalReviewReceipt,
  GoalReviewVerdict,
  GoalBlocker,
  GoalBudgetSummary,
  HitlRecord,
  HitlResponse,
  HitlDisplayPayload,
  HitlQuestionDisplayItem,
  HitlSource,
  HitlProjection,
  HitlProjectionContext,
  HitlAllowedAction,
  HitlOwnerKey,
  HitlIdentity,
  HitlOwnerType,
  HitlStatus,
  DiffLineType,
  DiffLine,
  DiffHunk,
  DiffFile,
  ApiCommandResult,
  LoopConfig,
  LoopState,
  LoopStatus,
  LoopRunReport,
  LoopRunKind,
  LoopTemplateId,
  LoopApprovalPolicy,
  LoopLimits,
  LoopGoalTemplate,
  LoopScheduleSpec,
  LoopTriggerSpec,
  LoopTriggerHealth,
  LoopCleanupState,
  LoopWorktreeArtifact,
  LoopRunReportStatus,
  LoopRunTrigger,
  LoopBudgetConfig,
  LoopBudgetSnapshot,
  LoopCollisionSnapshot,
  LoopIntegrationError,
} from "@archcode/protocol";

// ─── Dashboard aggregate types ───
// Server augments GoalState/HITL records with project metadata and exposes
// redacted displayPayload (never raw payload) for HITL items.

import type {
  GoalState,
  HitlProjection,
  LoopApprovalPolicy,
  LoopBudgetConfig,
  LoopGoalTemplate,
  LoopRunReport,
  LoopRunReportStatus,
  LoopRunTrigger,
  LoopScheduleSpec,
  LoopState,
  LoopStatus,
  LoopTemplateId,
  LoopTriggerSpec,
} from "@archcode/protocol";

// ─── Unified HITL API types ───

/** Scope filter for the canonical HITL list route. */
export type HitlScope = "project" | "session" | "goal" | "loop";

/** Status filter for the canonical HITL list route. */
export type HitlStatusFilter = "pending" | "recent" | "all";

/** Response of GET /api/projects/:slug/hitl?scope=...&ownerId=...&includeChildren=...&status=... */
export interface HitlListResponse {
  hitl: HitlProjection[];
}

/** Goal with project metadata, returned by GET /api/goals?status=active. */
export type DashboardGoal = GoalState & {
  projectSlug: string;
  projectName: string;
};

// ─── Loop API response types ───

/** Dashboard loop summary with minimal list fields. */
export interface DashboardLoopRunSummary {
  runId: string;
  status: LoopRunReportStatus;
  trigger: LoopRunTrigger;
  startedAt: number;
  endedAt?: number;
  sessionId?: string;
  reason?: string;
  summary?: string;
  error?: string;
}

export interface DashboardLoop {
  loopId: string;
  title: string | null;
  status: LoopStatus;
  currentRun?: DashboardLoopRunSummary;
  lastRun?: DashboardLoopRunSummary;
  nextRunAt?: number;
  templateId: LoopTemplateId;
  projectSlug: string;
  projectName: string;
}

/**
 * Minimal template-oriented create payload for `POST /api/projects/:slug/loops`.
 * The server maps `templateId` to the internal Loop template. This payload never
 * sends `mode`, `toolProfileId`, `extraTools`, `collisionTargets`, or
 * `cleanupPolicy`. `limits` and `useWorktree` are explicit canonical fields.
 */
export interface CreateLoopPayload {
  templateId: LoopTemplateId;
  schedule: LoopScheduleSpec;
  approvalPolicy: LoopApprovalPolicy;
  limits: LoopBudgetConfig;
  taskPrompt?: string;
  goalTemplate?: Omit<LoopGoalTemplate, "title">;
  triggers?: LoopTriggerSpec[];
  useWorktree: boolean;
}

/** Template-oriented update payload for `PATCH /api/projects/:slug/loops/:loopId`. */
export interface UpdateLoopPayload {
  status?: LoopStatus;
  templateId?: LoopTemplateId;
  schedule?: LoopScheduleSpec;
  approvalPolicy?: LoopApprovalPolicy;
  limits?: LoopBudgetConfig;
  taskPrompt?: string;
  goalTemplate?: Omit<LoopGoalTemplate, "title">;
  triggers?: LoopTriggerSpec[];
  useWorktree?: boolean;
}

/** Response of GET /api/projects/:slug/loops/:loopId/state. */
export interface LoopStateResponse {
  markdown: string;
  state: LoopState;
}

// ─── Loop guardrail API response types ───

import type {
  LoopBudgetSnapshot,
  LoopCollisionSnapshot,
  LoopIntegrationSnapshot,
  LoopIntegrationId,
} from "@archcode/protocol";

/** Loop kill state (server-side type not exported from protocol; defined here locally). */
export interface LoopKillState {
  readonly globalKillActive: boolean;
  readonly activatedAt?: number;
  readonly activatedBy?: string;
  readonly reason?: string;
}

/**
 * Per-integration status matching agent-core LoopIntegrationStatus shape.
 * Server returns this under LoopIntegrationStatusSnapshot.statuses[].
 */
export interface LoopIntegrationStatusItem {
  readonly integrationId: LoopIntegrationId;
  readonly status: "disabled" | "ready" | "auth_missing" | "rate_limited" | "error";
  readonly reason?: "integration_auth_missing" | "integration_rate_limited";
  readonly message?: string;
  readonly retryAfterMs?: number;
  readonly updatedAt: number;
}

/**
 * Integration status snapshot matching agent-core LoopIntegrationStatusSnapshot.
 * Server returns this from GET /api/projects/:slug/loops/:loopId/integrations.
 */
export interface LoopIntegrationStatusSnapshot {
  readonly statuses: LoopIntegrationStatusItem[];
  readonly snapshot: LoopIntegrationSnapshot | null;
  readonly updatedAt: number;
}

/** Response of GET /api/projects/:slug/loops/:loopId/budget. */
export interface LoopBudgetResponse {
  loopId: string;
  budget: LoopBudgetSnapshot | null;
}

/** Response of GET /api/projects/:slug/loops/:loopId/collisions. */
export interface LoopCollisionsResponse {
  loopId: string;
  collisions: LoopCollisionSnapshot;
}

/** Response of GET /api/projects/:slug/loops/:loopId/integrations. */
export interface LoopIntegrationsResponse {
  loopId: string;
  integrations: LoopIntegrationStatusSnapshot;
}

/** Response of GET /api/projects/:slug/loops/kill-state. */
export interface LoopKillStateResponse {
  killState: LoopKillState;
}

/** Response of POST /api/projects/:slug/loops/:loopId/runs/current/cancel. */
export interface CancelCurrentRunResponse {
  ok: boolean;
  loopId: string;
  runId: string | null;
  status: string;
  reason?: string;
  report?: LoopRunReport;
}
