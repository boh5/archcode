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
  PendingSessionMessage,
  SessionStep,
  SessionTodo,
  SessionGoal,
  SessionGoalStatus,
  HitlResponse,
  HitlDisplayPayload,
  HitlQuestionDisplayItem,
  HitlSource,
  HitlView,
  HitlAllowedAction,
  HitlOwner,
  HitlStatus,
  DiffLineType,
  DiffLine,
  DiffHunk,
  DiffFile,
  Automation,
  AutomationAction,
  AutomationInvocation,
  AutomationInvocationStatus,
  AutomationStatus,
  AutomationTrigger,
  ProjectTodo,
  ProjectTodoStatus,
  ProjectTodoActivationKind,
  ProjectTodoCreateInput,
  ProjectTodoUpdateInput,
  ProjectTodoMutationInput,
} from "@archcode/protocol";

// ─── Dashboard aggregate types ───
// Server augments Session goal/HITL records with project metadata and exposes
// redacted displayPayload (never raw payload) for HITL items.

import type { Automation, AutomationAction, AutomationTrigger, HitlView, Session, SessionGoal, SessionGoalStatus, SessionSummary } from "@archcode/protocol";

/** Visible Session-owned Goal projection, returned by Session and dashboard APIs. */
export type SessionGoalView = SessionGoal;

export type SessionWithGoal = Session & { goal?: SessionGoalView };
export type SessionSummaryWithGoal = SessionSummary & { goal?: SessionGoalView };

/** Session-owned Goal projection with project metadata, returned by GET /api/session-goals. */
export interface DashboardSessionGoal {
  sessionId: string;
  sessionTitle: string | null;
  updatedAt: number;
  projectName: string;
  projectSlug: string;
  goal: {
    objective: string;
    status: SessionGoalStatus;
    tokensUsed?: number;
    timeUsedSeconds?: number;
    latestReason?: string;
  };
}

export interface DashboardAutomation extends Automation {
  projectName: string;
}

export interface UpdateAutomationPayload {
  name?: string;
  trigger?: AutomationTrigger;
  action?: AutomationAction;
}
