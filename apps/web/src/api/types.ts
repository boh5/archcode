export type {
  AgentDescriptor,
  Project,
  DirectoryEntry,
  DirectoryListResponse,
  DirectorySearchResponse,
  SessionSummary,
  RootSessionSummary,
  ProjectSessionInventoryItem,
  ProjectAutomationInventoryItem,
  ProjectTodoRunNowResponse,
  ProjectTodoStartDiscussionResponse,
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
  AttachmentDescriptor,
  ProjectTodoResponse,
  ProjectTodoAttachmentListResponse,
  ProjectTodoAttachmentMutationResponse,
  ProjectTodoStatus,
  ProjectTodoCreateInput,
  ProjectTodoUpdateInput,
  CreateProjectTodoSessionInput,
  ProjectTodoStartDiscussionInput,
} from "@archcode/protocol";

import type {
  AutomationAction,
  AutomationTrigger,
  Session as ProtocolSession,
  SessionGoal,
  SessionProjection,
  SessionSummary,
} from "@archcode/protocol";

export interface ProjectTodoPlan {
  path: string;
  markdown: string;
  updatedAt: number;
}

/** Complete persisted Session file returned by the Session detail endpoint. */
export type Session = ProtocolSession & Pick<SessionProjection, "compression">;

/** Visible Session-owned Goal projection returned by Session and Home APIs. */
export type SessionGoalView = SessionGoal;

export type SessionWithGoal = Session & { goal?: SessionGoalView };
export type SessionSummaryWithGoal = SessionSummary & { goal?: SessionGoalView };

export interface UpdateAutomationPayload {
  name?: string;
  trigger?: AutomationTrigger;
  action?: AutomationAction;
}
