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
  GoalPhase,
  DoneCondition,
  DoneResult,
  RetryPolicy,
  ApprovalPoint,
  HitlRecord,
  HitlResponse,
  HitlDisplayPayload,
  HitlQuestionDisplayItem,
  HitlSource,
  HitlProjection,
  HitlProjectionContext,
  HitlAllowedAction,
  HitlOwnerKey,
  HitlOwnerType,
  HitlStatus,
  DiffLineType,
  DiffLine,
  DiffHunk,
  DiffFile,
  CommandResult,
  GoalArtifactName,
  GoalArtifactFile,
  LoopConfig,
  LoopState,
  LoopStatus,
  LoopRunReport,
  LoopRunKind,
  LoopMode,
  LoopApprovalPolicy,
  LoopLimits,
  LoopGoalTemplate,
  LoopScheduleSpec,
  LoopTriggerSpec,
  LoopTriggerHealth,
  LoopJobSummary,
  LoopCleanupState,
  LoopWorktreeArtifact,
  LoopRunReportStatus,
  LoopRunTrigger,
  LoopBudgetConfig,
  LoopBudgetSnapshot,
  LoopCollisionSnapshot,
  LoopIntegrationError,
  LoopToolProfileId,
} from "@archcode/protocol";

// ─── Dashboard aggregate types ───
// Server augments GoalState/HITL records with project metadata and exposes
// redacted displayPayload (never raw payload) for HITL items.

import type { GoalArtifactFile, GoalState, HitlProjection, LoopRunReport, LoopRunKind, LoopMode, LoopState, LoopStatus } from "@archcode/protocol";

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

// ─── Goal artifact API response types ───
// Match the read-only project-scoped artifact routes.

/** Response of GET /api/projects/:slug/goals/:goalId/artifacts. */
export interface GoalArtifactsListResponse {
  artifacts: GoalArtifactFile[];
}

/** Response of GET /api/projects/:slug/goals/:goalId/artifacts/:artifactName. */
export interface GoalArtifactReadResponse {
  artifact?: GoalArtifactFile;
  content: string;
}

// ─── Loop API response types ───

/** Dashboard loop summary with minimal list fields. */
export interface DashboardLoop {
  loopId: string;
  title: string;
  status: LoopStatus;
  currentRun?: LoopRunReport;
  lastRun?: LoopRunReport;
  nextRunAt?: number;
  runKind: LoopRunKind;
  mode: LoopMode;
  projectSlug: string;
  projectName: string;
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
