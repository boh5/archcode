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
  PermissionRequest,
  QuestionRequest,
  CommandResult,
  PermissionDecision,
  QuestionAnswerBody,
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

import type { ApprovalPoint, GoalArtifactFile, GoalState, HitlAllowedAction, HitlDisplayPayload, HitlOwnerKey, HitlProjection, HitlSource, LoopRunReport, LoopRunKind, LoopMode, LoopState, LoopStatus } from "@archcode/protocol";

// ─── Unified HITL API types ───

/** Scope filter for the canonical HITL list route. */
export type HitlScope = "project" | "session" | "goal" | "loop";

/** Status filter for the canonical HITL list route. */
export type HitlStatusFilter = "pending" | "recent" | "all";

/** Response of GET /api/projects/:slug/hitl?scope=...&ownerId=...&includeChildren=...&status=... */
export interface HitlListResponse {
  hitl: HitlProjection[];
}

/** Convert a legacy DashboardHitlItem into a HitlProjection for unified rendering. */
export function dashboardHitlItemToProjection(item: DashboardHitlItem): HitlProjection {
  const source = dashboardHitlItemToSource(item);
  const owner: HitlOwnerKey = {
    projectSlug: item.projectSlug,
    ownerType: "session",
    ownerId: item.sessionId,
  };
  return {
    hitlId: item.hitlId,
    project: { slug: item.projectSlug, name: item.projectName },
    owner,
    ancestry: item.trigger.goalId || item.trigger.loopId
      ? {
          goalId: item.trigger.goalId,
          loopId: item.trigger.loopId,
        }
      : undefined,
    source,
    status: item.status,
    displayPayload: item.displayPayload,
    allowedActions: dashboardHitlAllowedActions(item),
    createdAt: typeof item.createdAt === "number" ? new Date(item.createdAt).toISOString() : item.createdAt,
    updatedAt: typeof item.createdAt === "number" ? new Date(item.createdAt).toISOString() : item.createdAt,
  };
}

function dashboardHitlItemToSource(item: DashboardHitlItem): HitlSource {
  const trigger = item.trigger;
  if (item.kind === "question") {
    return { type: "ask_user", sessionId: item.sessionId, toolCallId: trigger.toolCallId };
  }
  if (item.kind === "review") {
    return { type: "goal_review", goalId: trigger.goalId ?? "" };
  }
  const approvalPoint = (trigger.approvalPoint ?? "after_plan") as ApprovalPoint;
  if (trigger.source?.startsWith("goal.")) {
    return { type: "goal_approval", goalId: trigger.goalId ?? "", approvalPoint };
  }
  if (trigger.loopId) {
    return { type: "loop_approval", loopId: trigger.loopId, approvalPoint };
  }
  return { type: "goal_approval", goalId: trigger.goalId ?? "", approvalPoint };
}

function dashboardHitlAllowedActions(item: DashboardHitlItem): HitlAllowedAction[] {
  if (item.kind === "question") return ["answer", "cancel"];
  if (item.kind === "review") return ["approve", "deny", "cancel"];
  return ["approve", "deny", "cancel"];
}

/** Goal with project metadata, returned by GET /api/goals?status=active. */
export type DashboardGoal = GoalState & {
  projectSlug: string;
  projectName: string;
};

/** Redacted display payload from server HITL list routes. Raw payload is never exposed. */
export type DashboardHitlKind = "question" | "approval" | "review";

export interface DashboardHitlTrigger {
  projectSlug?: string;
  goalId?: string;
  loopId?: string;
  source?: string;
  approvalPoint?: string;
  toolCallId?: string;
  timeoutMs?: number;
}

/** HITL item with project metadata. Uses redacted displayPayload only; raw payload is never included. */
export interface DashboardHitlItem {
  hitlId: string;
  owner?: HitlOwnerKey;
  blockingKey?: string;
  source?: HitlSource;
  displayPayload: HitlDisplayPayload;
  createdAt: string | number;
  updatedAt?: string;
  /** Display-safe compatibility fields used by existing dashboard views. No raw payload/input is exposed. */
  sessionId: string;
  kind: DashboardHitlKind;
  trigger: DashboardHitlTrigger;
  approvalKey?: string;
  projectSlug: string;
  projectName: string;
  status: "pending";
}

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
