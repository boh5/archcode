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
} from "@archcode/protocol";

// ─── Dashboard aggregate types ───
// These match the server's dashboard route responses (T16).
// The server augments GoalState / HitlRequest with project metadata
// and uses the agent-core HitlRequest shape (hitlId, not protocol id).

import type { GoalState, HitlKind } from "@archcode/protocol";

/** Goal with project metadata, returned by GET /api/goals?status=active. */
export type DashboardGoal = GoalState & {
  projectSlug: string;
  projectName: string;
};

/** Display fields shared by all HITL payload variants (agent-core HitlPayload). */
export interface HitlDisplayFields {
  title?: string;
  message?: string;
  details?: Record<string, unknown>;
  options?: Array<{ label: string; description?: string; id?: string }>;
  recommendedOptionId?: string;
  rationale?: string;
}

/** HITL payload variants matching the agent-core HitlPayload union. */
export type DashboardHitlPayload = HitlDisplayFields & (
  | {
      kind: "question";
      options?: Array<{ label: string; description?: string }>;
      multiple?: boolean;
      custom?: boolean;
      recommendedOption?: string;
      rationale?: string;
    }
  | {
      kind: "approval";
      action: string;
      context: Record<string, unknown>;
    }
  | {
      kind: "review";
      artifacts: Array<{ path: string; description: string }>;
    }
  | {
      kind?: undefined;
      title: string;
      message: string;
    }
);

/** HITL trigger metadata from the agent-core HitlRequest. */
export interface DashboardHitlTrigger {
  projectSlug?: string;
  goalId?: string;
  loopId?: string;
  source?: string;
  timeoutMs?: number;
}

/** HITL item with project metadata, returned by GET /api/hitl?status=pending. */
export interface DashboardHitlItem {
  hitlId: string;
  sessionId: string;
  kind: HitlKind;
  payload: DashboardHitlPayload;
  trigger: DashboardHitlTrigger;
  createdAt: number;
  projectSlug: string;
  projectName: string;
  status: "pending";
}
