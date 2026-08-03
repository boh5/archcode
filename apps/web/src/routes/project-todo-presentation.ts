import {
  Archive,
  CircleCheck,
  CircleDot,
  CirclePlay,
  CircleX,
  Lightbulb,
  type LucideIcon,
} from "lucide-react";
import type {
  ProjectAutomationInventoryItem,
  ProjectSessionInventoryItem,
  ProjectTodo,
  SessionFamilyActivity,
} from "@archcode/protocol";
import type { StatusTone, VisualStatusKind } from "../lib/status-visuals";

export type ProjectTodoLane = "idea" | "ready" | "in_progress" | "done";
export type ProjectTodoStatus = ProjectTodoLane | "rejected";

export interface ProjectTodoCardPresentation {
  readonly label: "Idea" | "Ready" | "In Progress" | "Done" | "Rejected" | "Archived";
  readonly Icon: LucideIcon;
  readonly tone: StatusTone;
}

export interface ProjectTodoLanePresentation {
  readonly title: string;
  readonly hint: string;
  readonly emptyTitle: string;
  readonly emptyHint: string;
  readonly Icon: LucideIcon;
  readonly tone: StatusTone;
}

export type ProjectTodoAttentionLabel = "Inspection" | "Permission" | "Question";

export interface ProjectTodoOperationalState {
  readonly label: "Needs you" | "Working" | "Needs attention" | "Ready to review" | "Scheduled" | "Idle";
  readonly detail?: string;
  readonly kind: VisualStatusKind;
}

export interface ProjectTodoOperationalFacts {
  readonly todo: ProjectTodo;
  readonly sessions: readonly ProjectSessionInventoryItem[];
  readonly automations: readonly ProjectAutomationInventoryItem[];
  readonly activityBySessionId: ReadonlyMap<string, SessionFamilyActivity>;
  readonly attentionBySessionId: ReadonlyMap<string, ProjectTodoAttentionLabel>;
  /** Prevents a provisional Idle while inventory or realtime snapshots are incomplete. */
  readonly authoritative: boolean;
}

const CARD_PRESENTATIONS: Readonly<Record<ProjectTodoCardPresentation["label"], ProjectTodoCardPresentation>> = {
  Idea: { label: "Idea", Icon: Lightbulb, tone: "brand" },
  Ready: { label: "Ready", Icon: CircleDot, tone: "neutral" },
  "In Progress": { label: "In Progress", Icon: CirclePlay, tone: "signal" },
  Done: { label: "Done", Icon: CircleCheck, tone: "success" },
  Rejected: { label: "Rejected", Icon: CircleX, tone: "warning" },
  Archived: { label: "Archived", Icon: Archive, tone: "neutral" },
};

export const PROJECT_TODO_LANE_PRESENTATIONS: Readonly<Record<ProjectTodoLane, ProjectTodoLanePresentation>> = {
  idea: { title: "Ideas", hint: "Capture first, shape later", emptyTitle: "No ideas yet", emptyHint: "Capture an idea above.", Icon: Lightbulb, tone: "brand" },
  ready: { title: "Ready", hint: "Clear enough to hand off", emptyTitle: "Nothing ready", emptyHint: "Move an idea here when it is ready.", Icon: CircleDot, tone: "neutral" },
  in_progress: { title: "In Progress", hint: "Work underway", emptyTitle: "No work in progress", emptyHint: "Start work or drag a Todo here.", Icon: CirclePlay, tone: "signal" },
  done: { title: "Done", hint: "Explicitly completed", emptyTitle: "Nothing completed", emptyHint: "Completed Todos stay visible here.", Icon: CircleCheck, tone: "success" },
};

/** Pure display mapping; Todo status is the only lifecycle source of truth. */
export function presentProjectTodoCard(input: {
  readonly status: ProjectTodoStatus;
  readonly archivedAt?: number;
}): ProjectTodoCardPresentation {
  if (input.archivedAt !== undefined) return CARD_PRESENTATIONS.Archived;
  if (input.status === "rejected") return CARD_PRESENTATIONS.Rejected;
  if (input.status === "done") return CARD_PRESENTATIONS.Done;
  if (input.status === "in_progress") return CARD_PRESENTATIONS["In Progress"];
  if (input.status === "ready") return CARD_PRESENTATIONS.Ready;
  return CARD_PRESENTATIONS.Idea;
}

/**
 * Page-local projection of existing work facts. This never extends or mutates
 * the persisted Todo lifecycle.
 */
export function deriveProjectTodoOperationalState(
  facts: ProjectTodoOperationalFacts,
): ProjectTodoOperationalState | undefined {
  if (!facts.authoritative || facts.todo.archivedAt !== undefined || facts.todo.status !== "in_progress") {
    return undefined;
  }

  const linkedAutomations = facts.automations.filter(({ automation }) => (
    automation.origin.kind === "todo" && automation.origin.todoId === facts.todo.id
  ));
  const linkedAutomationIds = new Set(linkedAutomations.map(({ automation }) => automation.id));
  const workSessions = facts.sessions
    .filter(({ session }) => (
      (session.source.kind === "todo"
        && session.source.todoId === facts.todo.id
        && session.source.entry === "work")
      || (session.source.kind === "automation" && linkedAutomationIds.has(session.source.automationId))
    ))
    .sort(compareSessionRecency);

  for (const { session } of workSessions) {
    const attention = facts.attentionBySessionId.get(session.sessionId);
    if (attention !== undefined) return { label: "Needs you", detail: attention, kind: "needs_you" };
  }
  for (const { session } of workSessions) {
    if (session.goal?.status === "budget_limited") {
      return { label: "Needs you", detail: "Budget limit", kind: "needs_you" };
    }
    if (session.goal?.status === "blocked") {
      return { label: "Needs you", detail: "Goal blocked", kind: "needs_you" };
    }
  }
  for (const { session } of workSessions) {
    if (facts.activityBySessionId.get(session.sessionId) === "waiting_for_human") {
      return { label: "Needs you", detail: "Waiting for response", kind: "needs_you" };
    }
  }
  for (const { session } of workSessions) {
    const activity = facts.activityBySessionId.get(session.sessionId) ?? "idle";
    if (activity !== "idle") {
      return { label: "Working", detail: activityDetail(activity), kind: "running" };
    }
  }

  const latestSession = workSessions[0];
  const latestInvocation = linkedAutomations
    .map(({ latestInvocation }) => latestInvocation)
    .filter((invocation) => invocation !== null)
    .sort((left, right) => invocationTime(right) - invocationTime(left) || right.id.localeCompare(left.id))[0];
  const sessionIsLatest = latestSession !== undefined
    && (latestInvocation === undefined || sessionTime(latestSession) >= invocationTime(latestInvocation));

  if (sessionIsLatest) {
    const status = latestSession.latestExecution?.status;
    const detail = status === undefined || status === "running" || status === "completed"
      ? undefined
      : executionAttentionDetail(status);
    if (detail !== undefined) return { label: "Needs attention", detail, kind: "warning" };
    if (status === "completed") return { label: "Ready to review", kind: "completed" };
  } else if (latestInvocation?.status === "failed" || latestInvocation?.status === "missed") {
    return {
      label: "Needs attention",
      detail: latestInvocation.status === "missed" ? "Automation missed" : "Automation failed",
      kind: "warning",
    };
  }

  if (linkedAutomations.some(({ automation }) => automation.status === "active" && automation.nextFireAt !== undefined)) {
    return { label: "Scheduled", kind: "enabled" };
  }
  return { label: "Idle", kind: "idle" };
}

function compareSessionRecency(left: ProjectSessionInventoryItem, right: ProjectSessionInventoryItem): number {
  return right.session.updatedAt - left.session.updatedAt
    || right.session.sessionId.localeCompare(left.session.sessionId);
}

function sessionTime(item: ProjectSessionInventoryItem): number {
  return Math.max(
    item.session.updatedAt,
    item.latestExecution?.endedAt ?? item.latestExecution?.startedAt ?? 0,
  );
}

function invocationTime(invocation: NonNullable<ProjectAutomationInventoryItem["latestInvocation"]>): number {
  return Date.parse(invocation.completedAt ?? invocation.dispatchedAt ?? invocation.createdAt);
}

function activityDetail(activity: Exclude<SessionFamilyActivity, "idle">): string {
  if (activity === "waiting_for_human") return "Waiting for response";
  if (activity === "resuming") return "Resuming";
  if (activity === "stopping") return "Stopping";
  return "Running";
}

function executionAttentionDetail(
  status: Exclude<NonNullable<ProjectSessionInventoryItem["latestExecution"]>["status"], "running" | "completed">,
): string {
  if (status === "timed_out") return "Timed out";
  if (status === "max_steps") return "Max steps";
  if (status === "suspended") return "Suspended";
  return status.charAt(0).toUpperCase() + status.slice(1);
}
