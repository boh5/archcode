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
  HitlRequest,
  HitlResponse,
  HitlKind,
  HitlPayload,
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
} from "@archcode/protocol";

// ─── Dashboard aggregate types ───
// Server augments GoalState/HitlRequest with project metadata and exposes
// redacted displayPayload (never raw payload) for HITL items.

import type { GoalArtifactFile, GoalState, HitlKind } from "@archcode/protocol";

/** Goal with project metadata, returned by GET /api/goals?status=active. */
export type DashboardGoal = GoalState & {
  projectSlug: string;
  projectName: string;
};

/** Redacted display payload from server HITL list routes. Raw payload is never exposed. */
export interface DashboardHitlDisplayPayload {
  title: string;
  summary?: string;
  fields?: Array<{ label: string; value: string }>;
  redacted: true;
}

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
  sessionId: string;
  kind: HitlKind;
  displayPayload: DashboardHitlDisplayPayload;
  trigger: DashboardHitlTrigger;
  createdAt: number;
  approvalKey?: string;
  projectSlug: string;
  projectName: string;
  status: "pending";
}

// ─── Goal artifact API response types ───
// Match the read-only project-scoped artifact routes from Task 11.

/** Response of GET /api/projects/:slug/goals/:goalId/artifacts. */
export interface GoalArtifactsListResponse {
  artifacts: GoalArtifactFile[];
}

/** Response of GET /api/projects/:slug/goals/:goalId/artifacts/:artifactName. */
export interface GoalArtifactReadResponse {
  artifact?: GoalArtifactFile;
  content: string;
}
