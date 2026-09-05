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
import { sessionFamilyActivityLabel, sessionFamilyVisual } from "../lib/session-family-presentation";
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
  readonly emptyTitle: string;
  readonly Icon: LucideIcon;
}

export type ProjectTodoAttentionLabel = "Inspection" | "Permission" | "Question";

export interface ProjectTodoOperationalState {
  readonly label: "Needs you" | "Failed" | "Waiting" | "Working" | "Ready to review" | "Scheduled";
  readonly detail?: string;
  readonly kind: VisualStatusKind;
}

export interface ProjectTodoLinkedSessionPresentation {
  readonly context: string;
  readonly kind: VisualStatusKind;
  readonly label: string;
}

export interface ProjectTodoLinkedSessionFacts {
  readonly activity?: SessionFamilyActivity;
  readonly attention?: ProjectTodoAttentionLabel;
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
  "In Progress": { label: "In Progress", Icon: Activity, tone: "neutral" },
  Done: { label: "Done", Icon: Check, tone: "success" },
  Rejected: { label: "Rejected", Icon: CircleX, tone: "warning" },
  Archived: { label: "Archived", Icon: Archive, tone: "neutral" },
};

export const PROJECT_TODO_LANE_PRESENTATIONS: Readonly<Record<ProjectTodoLane, ProjectTodoLanePresentation>> = {
  idea: { title: "Ideas", emptyTitle: "No ideas yet", Icon: Sparkles },
  ready: { title: "Ready", emptyTitle: "Nothing ready", Icon: Play },
  in_progress: { title: "In Progress", emptyTitle: "No work in progress", Icon: Activity },
  done: { title: "Done", emptyTitle: "Nothing completed", Icon: Check },
};

const PROJECT_TODO_DISPLAY_LEAD_MAX_LENGTH = 80;
const PROJECT_TODO_PREVIEW_EXCERPT_MAX_LENGTH = 180;

const PROJECT_TODO_NON_CONTENT_LINES = new Set([
  "todo shaping template",
  "todo title",
  "<todo title>",
  "outcome",
  "evidence",
  "scope and non-goals",
  "decisions",
  "dependencies and risks",
  "acceptance",
  "given <starting state>, when <action/event>, then <observable result>.",
  "failure/edge case: <decidable behavior>.",
  "verification or inspection:",
]);

const PROJECT_TODO_FIELD_PREFIXES = [
  "problem observed:",
  "intended user-visible result:",
  "repository/runtime fact:",
  "existing behavior or constraint:",
  "assumption still needing evidence:",
  "included owner/flow/interface:",
  "explicitly excluded:",
  "confirmed direction and rationale:",
  "remaining product choice for the user:",
  "prerequisite, external authority, migration, or sequencing risk:",
  "control or decision required:",
] as const;

/** Canonical display-only lead. It never creates a persisted Todo title field. */
export function projectTodoDisplayLead(content: string): string {
  const lines = nonFencedTodoLines(content);
  const concreteH1 = lines
    .filter((line) => /^#[ \t]+/u.test(line))
    .map(normalizeTodoDisplayLine)
    .find(isConcreteTodoDisplayLine);
  const concreteBody = lines
    .map(normalizeTodoDisplayLine)
    .find(isConcreteTodoDisplayLine);
  const source = concreteH1 ?? concreteBody ?? "Untitled Todo";
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
  const atxHeading = /^#{1,6}[ \t]+/u.test(line);
  const withoutClosingSequence = atxHeading
    ? line.replace(/[ \t]+#+[ \t]*$/u, "")
    : line;
  const plain = withoutClosingSequence
    .replace(/^(?:#{1,6}|>|[-+*]|\d+[.)])\s+/u, "")
    .replace(/^\[[ xX]\]\s*/u, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<((?:https?):\/\/[^>]+)>/giu, "$1")
    .replace(/(\*\*|__)(.+?)\1/gu, "$2")
    .replace(/~~(.+?)~~/gu, "$1")
    .replace(/`+([^`]+)`+/gu, "$1")
    .replace(/(^|\s)\*([^*]+)\*(?=\s|$)/gu, "$1$2")
    .replace(/(^|\s)_([^_]+)_(?=\s|$)/gu, "$1$2")
    .trim();
  const lower = plain.toLocaleLowerCase("en-US");
  const prefix = PROJECT_TODO_FIELD_PREFIXES.find((candidate) => lower.startsWith(candidate));
  return prefix === undefined ? plain : plain.slice(prefix.length).trim();
}

function nonFencedTodoLines(content: string): string[] {
  const lines: string[] = [];
  let fence: { readonly kind: "`" | "~"; readonly length: number } | undefined;
  for (const rawLine of content.split(/\r?\n/u)) {
    const marker = rawLine.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence !== undefined) {
      if (marker?.[1]?.[0] === fence.kind && marker[1].length >= fence.length && marker[2]?.trim().length === 0) {
        fence = undefined;
      }
      continue;
    }
    if (marker?.[1] !== undefined) {
      fence = { kind: marker[1][0] as "`" | "~", length: marker[1].length };
      continue;
    }
    const line = rawLine.trim();
    if (line.length > 0) lines.push(line);
  }
  return lines;
}

function isConcreteTodoDisplayLine(line: string): boolean {
  const candidate = line.trim();
  if (
    candidate.length === 0
    || /^<[^>\n]+>$/u.test(candidate)
    || PROJECT_TODO_NON_CONTENT_LINES.has(candidate.toLocaleLowerCase("en-US"))
  ) return false;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return false;
  } catch {
    // A non-URL candidate can be concrete Todo content.
  }
  return true;
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
  facts: ProjectTodoLinkedSessionFacts = {},
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

  const workOrAutomation = session.source.kind === "automation"
    || (session.source.kind === "todo" && (session.source.entry === "work" || session.source.entry === "automation"));
  if (facts.attention !== undefined) return { context, kind: "needs_you", label: "Needs you" };
  if (workOrAutomation && (session.goal?.status === "blocked" || session.goal?.status === "budget_limited")) {
    return { context, kind: "needs_you", label: "Needs you" };
  }
  if (facts.activity === "waiting_for_human") {
    return {
      context,
      kind: sessionFamilyVisual(facts.activity).kind,
      label: sessionFamilyActivityLabel(facts.activity),
    };
  }
  if (facts.activity !== undefined && facts.activity !== "idle") return { context, kind: "running", label: "Running" };
  if (latestExecution === null) return { context, kind: "idle", label: "Idle" };
  if (latestExecution.status === "running") return { context, kind: "running", label: "Running" };
  if (latestExecution.status === "completed") return { context, kind: "completed", label: "Done" };
  if (latestExecution.status === "suspended") return { context, kind: "pending", label: "Waiting" };
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
  if (!facts.authoritative || facts.todo.archivedAt !== undefined || facts.todo.status === "rejected") {
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
    if (activity === "waiting_for_human") {
      return {
        label: "Waiting",
        detail: "Waiting for dependency",
        kind: sessionFamilyVisual(activity).kind,
      };
    }
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
    if (status === "completed" && facts.todo.status !== "done") {
      return { label: "Ready to review", kind: "completed" };
    }
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
  return undefined;
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
  if (activity === "waiting_for_human") return "Waiting for dependency";
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
