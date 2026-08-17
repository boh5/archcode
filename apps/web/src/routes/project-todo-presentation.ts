import {
  Activity,
  Archive,
  Check,
  CircleX,
  Play,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type {
  ProjectAutomationInventoryItem,
  ProjectSessionInventoryItem,
  ProjectTodo,
  SessionFamilyActivity,
} from "@archcode/protocol";
import { rootSessionSourceTodoId } from "@archcode/protocol";
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
  readonly label: "Needs you" | "Failed" | "Working" | "Ready to review" | "Scheduled" | "Idle";
  readonly detail?: string;
  readonly kind: VisualStatusKind;
}

export interface ProjectTodoLinkedSessionPresentation {
  readonly context: string;
  readonly kind: VisualStatusKind;
  readonly label: string;
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

/** Exact Todo attention: linked root HITL or a Work/Automation Goal gate. */
export function deriveProjectTodoNeedsUser(
  todo: ProjectTodo,
  sessions: readonly ProjectSessionInventoryItem[],
  attentionBySessionId: ReadonlyMap<string, unknown>,
): boolean {
  if (todo.archivedAt !== undefined || todo.status === "rejected") return false;
  const linkedRoots = sessions.filter(({ session }) => rootSessionSourceTodoId(session.source) === todo.id);
  if (linkedRoots.some(({ session }) => attentionBySessionId.has(session.sessionId))) return true;
  return linkedRoots.some(({ session }) => {
    const workOrAutomation = session.source.kind === "automation"
      || (session.source.kind === "todo" && (session.source.entry === "work" || session.source.entry === "automation"));
    return workOrAutomation
      && (session.goal?.status === "blocked" || session.goal?.status === "budget_limited");
  });
}

const CARD_PRESENTATIONS: Readonly<Record<ProjectTodoCardPresentation["label"], ProjectTodoCardPresentation>> = {
  Idea: { label: "Idea", Icon: Sparkles, tone: "neutral" },
  Ready: { label: "Ready", Icon: Play, tone: "brand" },
  "In Progress": { label: "In Progress", Icon: Activity, tone: "signal" },
  Done: { label: "Done", Icon: Check, tone: "success" },
  Rejected: { label: "Rejected", Icon: CircleX, tone: "warning" },
  Archived: { label: "Archived", Icon: Archive, tone: "neutral" },
};

export const PROJECT_TODO_LANE_PRESENTATIONS: Readonly<Record<ProjectTodoLane, ProjectTodoLanePresentation>> = {
  idea: { title: "Ideas", hint: "Captured, not committed", emptyTitle: "No ideas yet", emptyHint: "Capture an idea above.", Icon: Sparkles, tone: "neutral" },
  ready: { title: "Ready", hint: "Clear enough to start", emptyTitle: "Nothing ready", emptyHint: "Move an idea here when it is ready.", Icon: Play, tone: "brand" },
  in_progress: { title: "In Progress", hint: "Execution is attached here", emptyTitle: "No work in progress", emptyHint: "Start work or drag a Todo here.", Icon: Activity, tone: "signal" },
  done: { title: "Done", hint: "Explicitly accepted", emptyTitle: "Nothing completed", emptyHint: "Completed Todos stay visible here.", Icon: Check, tone: "success" },
};

const PROJECT_TODO_DISPLAY_LEAD_MAX_LENGTH = 80;
const PROJECT_TODO_PREVIEW_EXCERPT_MAX_LENGTH = 180;

/** Display-only lead used by the current prototype; it never creates a Todo title field. */
export function projectTodoDisplayLead(content: string): string {
  const lines = content.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => /^#{1,6}\s+/u.test(line));
  const source = heading !== undefined
    ? heading.replace(/^#{1,6}\s+/u, "")
    : normalizeTodoDisplayLine(lines[0] ?? "");
  return truncateTodoDisplayText(source.replace(/\s+/gu, " ").trim(), PROJECT_TODO_DISPLAY_LEAD_MAX_LENGTH);
}

/** Bounded plain-text body shown beneath the display lead in Todo Preview. */
export function projectTodoPreviewExcerpt(content: string): string {
  const lines = content.split(/\r?\n/u);
  const firstContentLine = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentLine >= 0 && /^#{1,6}\s+/u.test(lines[firstContentLine]!.trim())) lines.splice(firstContentLine, 1);
  const plain = lines.join("\n")
    .replace(/^#+\s+/gmu, "")
    .replace(/^[-*+]\s+/gmu, "")
    .replace(/^\d+[.)]\s+/gmu, "")
    .replace(/[#>*_`]/gu, "")
    .replace(/\n+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return truncateTodoDisplayText(plain, PROJECT_TODO_PREVIEW_EXCERPT_MAX_LENGTH);
}

function normalizeTodoDisplayLine(line: string): string {
  return line
    .replace(/^(?:#{1,6}|>|[-+*]|\d+[.)])\s+/u, "")
    .replace(/^\[[ xX]\]\s*/u, "");
}

function truncateTodoDisplayText(text: string, maxLength: number): string {
  const characters = Array.from(text);
  if (characters.length <= maxLength) return text;
  return `${characters.slice(0, maxLength - 1).join("").trimEnd()}…`;
}

/** Keep embedded Todo documents below the route h1 and their owning h2 section. */
export function demoteEmbeddedMarkdownHeadings(markdown: string): string {
  let fence: { readonly kind: "`" | "~"; readonly length: number } | undefined;
  return markdown.split(/\r?\n/u).map((line) => {
    if (fence !== undefined) {
      const closingMarker = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/u)?.[1];
      if (closingMarker !== undefined
        && closingMarker[0] === fence.kind
        && closingMarker.length >= fence.length) {
        fence = undefined;
      }
      return line;
    }

    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    const marker = opening?.[1];
    const info = opening?.[2] ?? "";
    if (marker !== undefined) {
      const kind = marker[0] as "`" | "~";
      if (kind === "~" || !info.includes("`")) {
        fence = { kind, length: marker.length };
      }
      return line;
    }
    return line.replace(
      /^(\s{0,3})(#{1,6})(\s+)/u,
      (_match, indentation: string, markers: string, spacing: string) => (
        `${indentation}${"#".repeat(Math.min(6, markers.length + 2))}${spacing}`
      ),
    );
  }).join("\n");
}

/** Project Todo detail projection for one durable linked Session row. */
export function presentProjectTodoLinkedSession(
  item: ProjectSessionInventoryItem,
): ProjectTodoLinkedSessionPresentation {
  const { session, latestExecution } = item;
  const agent = session.agentName.length > 0
    ? `${session.agentName[0]!.toUpperCase()}${session.agentName.slice(1)}`
    : "Lead";
  const context = session.source.kind === "todo"
    ? session.source.entry === "discussion"
      ? `${agent} · shapes intent and the current Plan`
      : session.source.entry === "automation"
        ? `${agent} · prepares an Automation from this Todo`
        : `${agent} · execution attached to this Todo`
    : session.source.kind === "automation"
      ? `${agent} · recurring execution attached to this Todo`
      : `${agent} · direct project execution`;

  if (latestExecution === null) return { context, kind: "idle", label: "Idle" };
  if (latestExecution.status === "running") return { context, kind: "running", label: "Running" };
  if (latestExecution.status === "completed") return { context, kind: "completed", label: "Done" };
  if (latestExecution.status === "suspended") return { context, kind: "needs_you", label: "Needs you" };
  if (["failed", "timed_out", "max_steps"].includes(latestExecution.status)) {
    return { context, kind: "failed", label: "Failed" };
  }
  return { context, kind: "stopped", label: "Stopped" };
}

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

  const linkedRoots = facts.sessions.filter(({ session }) => rootSessionSourceTodoId(session.source) === facts.todo.id);
  const linkedAutomations = facts.automations.filter(({ automation }) => (
    automation.origin.kind === "todo" && automation.origin.todoId === facts.todo.id
  ));
  const workSessions = facts.sessions
    .filter(({ session }) => (
      (session.source.kind === "todo"
        && session.source.todoId === facts.todo.id
        && session.source.entry === "work")
      || (
        session.source.kind === "automation"
        && rootSessionSourceTodoId(session.source) === facts.todo.id
      )
    ))
    .sort(compareSessionRecency);

  if (deriveProjectTodoNeedsUser(facts.todo, facts.sessions, facts.attentionBySessionId)) {
    for (const { session } of linkedRoots) {
      const attention = facts.attentionBySessionId.get(session.sessionId);
      if (attention !== undefined) return { label: "Needs you", detail: attention, kind: "needs_you" };
    }
    for (const { session } of linkedRoots) {
      const workOrAutomation = session.source.kind === "automation"
        || (session.source.kind === "todo" && (session.source.entry === "work" || session.source.entry === "automation"));
      if (!workOrAutomation) continue;
      if (session.goal?.status === "budget_limited") {
        return { label: "Needs you", detail: "Budget limit", kind: "needs_you" };
      }
      if (session.goal?.status === "blocked") {
        return { label: "Needs you", detail: "Goal blocked", kind: "needs_you" };
      }
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
    if (detail !== undefined) return { label: "Failed", detail, kind: "failed" };
    if (status === "completed") return { label: "Ready to review", kind: "completed" };
  } else if (latestInvocation?.status === "failed" || latestInvocation?.status === "missed") {
    return {
      label: "Failed",
      detail: latestInvocation.status === "missed" ? "Automation missed" : "Automation failed",
      kind: "failed",
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
