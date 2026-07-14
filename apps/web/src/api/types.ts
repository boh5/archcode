export type {
  AgentDescriptor,
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
  Automation,
  AutomationAction,
  AutomationInvocation,
  AutomationInvocationStatus,
  AutomationStatus,
  AutomationTrigger,
} from "@archcode/protocol";

// ─── Dashboard aggregate types ───
// Server augments GoalState/HITL records with project metadata and exposes
// redacted displayPayload (never raw payload) for HITL items.

import type { Automation, AutomationAction, AutomationTrigger, GoalState, HitlProjection } from "@archcode/protocol";

// ─── Unified HITL API types ───

/** Scope filter for the canonical HITL list route. */
export type HitlScope = "project" | "session" | "goal";

/** Status filter for the canonical HITL list route. */
export type HitlStatusFilter = "pending" | "recent" | "all";

/** Response of GET /api/projects/:slug/hitl?scope=...&ownerId=...&includeChildren=...&status=... */
export interface HitlListResponse {
  hitl: HitlProjection[];
}

/** Goal with project metadata, returned by GET /api/goals?status=active. */
export type DashboardGoal = GoalState & {
  projectName: string;
};

export interface DashboardAutomation extends Automation {
  projectName: string;
}

export interface UpdateAutomationPayload {
  name?: string;
  trigger?: AutomationTrigger;
  action?: AutomationAction;
}
