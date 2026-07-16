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
  GoalState,
  GoalStatus,
  GoalEvidenceRefKind,
  GoalEvidenceRef,
  GoalReviewReceipt,
  GoalReviewVerdict,
  GoalBudgetSummary,
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
// Server augments GoalState/HITL records with project metadata and exposes
// redacted displayPayload (never raw payload) for HITL items.

import type { Automation, AutomationAction, AutomationTrigger, GoalState, HitlView } from "@archcode/protocol";

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
