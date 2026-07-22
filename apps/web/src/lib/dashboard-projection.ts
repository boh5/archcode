import type {
  DashboardAutomation,
  DashboardAutomationInvocation,
  DashboardExecution,
  DashboardProjection,
  DashboardRootSession,
  HitlDisplayPayload,
  SessionGoal,
} from "@archcode/protocol";
import type { ScopedHitlView } from "../store/hitl-store";

export type { DashboardScope } from "@archcode/protocol";

export type DashboardReadProjection = Pick<DashboardProjection, "sessions" | "automations" | "errors">;

export type DashboardAttentionItem =
  | DashboardHitlAttentionItem
  | DashboardGoalAttentionItem
  | DashboardAutomationFailureAttentionItem
  | DashboardSessionFailureAttentionItem;

export interface DashboardHitlAttentionItem {
  readonly kind: "hitl";
  readonly identity: string;
  readonly sectionOwnerKey: string;
  readonly attentionSinceMs: number;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly rootSessionId: string;
  readonly ownerSessionId: string;
  readonly hitlId: string;
  readonly requiresInspection: boolean;
  readonly displayPayload: HitlDisplayPayload;
}

export interface DashboardGoalAttentionItem {
  readonly kind: "goal";
  readonly identity: string;
  readonly sectionOwnerKey: string;
  readonly attentionSinceMs: number;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly rootSessionId: string;
  readonly title: string | null;
  readonly goal: SessionGoal;
}

export interface DashboardAutomationFailureAttentionItem {
  readonly kind: "automation_failure";
  readonly identity: string;
  readonly sectionOwnerKey: string;
  readonly attentionSinceMs: number;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly automationId: string;
  readonly automationName: string;
  readonly invocation: DashboardAutomationInvocation;
}

export interface DashboardSessionFailureAttentionItem {
  readonly kind: "session_failure";
  readonly identity: string;
  readonly sectionOwnerKey: string;
  readonly attentionSinceMs: number;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly rootSessionId: string;
  readonly title: string | null;
  readonly execution: DashboardExecution;
}

export interface DashboardSessionRow {
  readonly kind: "session";
  readonly identity: string;
  readonly sectionOwnerKey: string;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly rootSessionId: string;
  readonly title: string | null;
  readonly updatedAt: number;
  readonly activity: "running" | "stopping" | "idle";
  readonly goal?: SessionGoal;
}

export interface DashboardAutomationRow {
  readonly kind: "automation";
  readonly identity: string;
  readonly sectionOwnerKey: string;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly automationId: string;
  readonly name: string;
  readonly status: DashboardAutomation["status"];
  readonly nextFireAt: string;
}

export interface DashboardSections {
  readonly attention: readonly DashboardAttentionItem[];
  readonly running: readonly DashboardSessionRow[];
  readonly continueWorking: readonly DashboardSessionRow[];
  readonly upcoming: readonly DashboardAutomationRow[];
}

export interface DeriveDashboardSectionsInput {
  readonly read: DashboardReadProjection;
  readonly hitl: readonly ScopedHitlView[];
  readonly activityFor: (projectSlug: string, rootSessionId: string) => "running" | "stopping" | "idle" | undefined;
}

const ATTENTION_KIND_ORDER: Record<DashboardAttentionItem["kind"], number> = {
  hitl: 0,
  goal: 1,
  automation_failure: 2,
  session_failure: 3,
};

/**
 * Derives the Dashboard's four mutually-exclusive sections from authoritative
 * read models plus the live HITL/runtime projections. It deliberately has no
 * fetch or persisted state: a later owner update simply removes its row.
 */
export function deriveDashboardSections(input: DeriveDashboardSectionsInput): DashboardSections {
  const sessionByFamily = new Map(
    input.read.sessions.map((session) => [sessionFamilyKey(session.projectSlug, session.rootSessionId), session]),
  );
  const attention = [
    ...input.hitl.map((entry) => toHitlAttention(entry, sessionByFamily)),
    ...input.read.sessions.flatMap(toGoalAttention),
    ...input.read.automations.flatMap(toAutomationFailureAttention),
    ...input.read.sessions.flatMap(toSessionFailureAttention),
  ].sort(compareAttention);

  const attentionOwnerKeys = new Set(attention.map((item) => item.sectionOwnerKey));
  const running = input.read.sessions
    .filter((session) => !attentionOwnerKeys.has(sessionFamilyKey(session.projectSlug, session.rootSessionId)))
    .filter((session) => {
      const activity = input.activityFor(session.projectSlug, session.rootSessionId);
      return activity === "running" || activity === "stopping";
    })
    .map((session) => toSessionRow(
      session,
      input.activityFor(session.projectSlug, session.rootSessionId) ?? "idle",
    ))
    .sort((left, right) => {
      const leftActivity = input.activityFor(left.projectSlug, left.rootSessionId);
      const rightActivity = input.activityFor(right.projectSlug, right.rootSessionId);
      return activityOrder(leftActivity) - activityOrder(rightActivity)
        || right.updatedAt - left.updatedAt
        || left.identity.localeCompare(right.identity);
    });

  const runningOwnerKeys = new Set(running.map((item) => item.sectionOwnerKey));
  const continueWorking = input.read.sessions
    .filter((session) => {
      const ownerKey = sessionFamilyKey(session.projectSlug, session.rootSessionId);
      return !attentionOwnerKeys.has(ownerKey)
        && !runningOwnerKeys.has(ownerKey)
        && input.activityFor(session.projectSlug, session.rootSessionId) === "idle";
    })
    .map((session) => toSessionRow(session, "idle"))
    .sort((left, right) => right.updatedAt - left.updatedAt || left.identity.localeCompare(right.identity))
    .slice(0, 10);

  const upcoming = input.read.automations
    .filter((automation) => automation.status === "active" && automation.nextFireAt !== undefined)
    .filter((automation) => !attentionOwnerKeys.has(automationOwnerKey(automation.projectSlug, automation.id)))
    .map(toAutomationRow)
    .sort((left, right) => left.nextFireAt.localeCompare(right.nextFireAt) || left.identity.localeCompare(right.identity))
    .slice(0, 10);

  return { attention, running, continueWorking, upcoming };
}

function toHitlAttention(
  entry: ScopedHitlView,
  sessionByFamily: ReadonlyMap<string, DashboardRootSession>,
): DashboardHitlAttentionItem {
  const identity = `hitl:${entry.projectSlug}:${entry.ownerSessionId}:${entry.view.hitlId}`;
  const family = sessionByFamily.get(sessionFamilyKey(entry.projectSlug, entry.rootSessionId));
  return {
    kind: "hitl",
    identity,
    sectionOwnerKey: sessionFamilyKey(entry.projectSlug, entry.rootSessionId),
    attentionSinceMs: parseIsoTime(entry.view.createdAt, identity),
    projectSlug: entry.projectSlug,
    projectName: family?.projectName ?? entry.projectSlug,
    rootSessionId: entry.rootSessionId,
    ownerSessionId: entry.ownerSessionId,
    hitlId: entry.view.hitlId,
    requiresInspection: entry.view.requiresInspection === true,
    displayPayload: entry.view.displayPayload,
  };
}

function toGoalAttention(session: DashboardRootSession): DashboardGoalAttentionItem[] {
  const goal = session.goal;
  if (!goal || (goal.status !== "blocked" && goal.status !== "budget_limited")) return [];
  const identity = `goal:${session.projectSlug}:${session.rootSessionId}:${goal.instanceId}`;
  return [{
    kind: "goal",
    identity,
    sectionOwnerKey: sessionFamilyKey(session.projectSlug, session.rootSessionId),
    attentionSinceMs: goal.updatedAt,
    projectSlug: session.projectSlug,
    projectName: session.projectName,
    rootSessionId: session.rootSessionId,
    title: session.sessionTitle,
    goal,
  }];
}

function toAutomationFailureAttention(automation: DashboardAutomation): DashboardAutomationFailureAttentionItem[] {
  const invocation = automation.latestInvocation;
  if (!invocation || invocation.status !== "failed") return [];
  const identity = `automation:${automation.projectSlug}:${automation.id}:${invocation.id}`;
  return [{
    kind: "automation_failure",
    identity,
    sectionOwnerKey: automationOwnerKey(automation.projectSlug, automation.id),
    attentionSinceMs: parseIsoTime(invocation.completedAt ?? invocation.createdAt, identity),
    projectSlug: automation.projectSlug,
    projectName: automation.projectName,
    automationId: automation.id,
    automationName: automation.name,
    invocation,
  }];
}

function toSessionFailureAttention(session: DashboardRootSession): DashboardSessionFailureAttentionItem[] {
  const execution = session.latestExecution;
  if (!execution || (execution.status !== "failed" && execution.status !== "timed_out")) return [];
  const identity = `session:${session.projectSlug}:${session.rootSessionId}:${execution.id}`;
  return [{
    kind: "session_failure",
    identity,
    sectionOwnerKey: sessionFamilyKey(session.projectSlug, session.rootSessionId),
    attentionSinceMs: execution.endedAt ?? execution.startedAt,
    projectSlug: session.projectSlug,
    projectName: session.projectName,
    rootSessionId: session.rootSessionId,
    title: session.sessionTitle,
    execution,
  }];
}

function toSessionRow(
  session: DashboardRootSession,
  activity: DashboardSessionRow["activity"],
): DashboardSessionRow {
  return {
    kind: "session",
    identity: sessionFamilyKey(session.projectSlug, session.rootSessionId),
    sectionOwnerKey: sessionFamilyKey(session.projectSlug, session.rootSessionId),
    projectSlug: session.projectSlug,
    projectName: session.projectName,
    rootSessionId: session.rootSessionId,
    title: session.sessionTitle,
    updatedAt: session.updatedAt,
    activity,
    goal: session.goal,
  };
}

function toAutomationRow(automation: DashboardAutomation): DashboardAutomationRow {
  return {
    kind: "automation",
    identity: automationOwnerKey(automation.projectSlug, automation.id),
    sectionOwnerKey: automationOwnerKey(automation.projectSlug, automation.id),
    projectSlug: automation.projectSlug,
    projectName: automation.projectName,
    automationId: automation.id,
    name: automation.name,
    status: automation.status,
    nextFireAt: automation.nextFireAt!,
  };
}

function compareAttention(left: DashboardAttentionItem, right: DashboardAttentionItem): number {
  const requiresInspection = Number(right.kind === "hitl" && right.requiresInspection) - Number(left.kind === "hitl" && left.requiresInspection);
  if (requiresInspection !== 0) return requiresInspection;
  const kindOrder = ATTENTION_KIND_ORDER[left.kind] - ATTENTION_KIND_ORDER[right.kind];
  return kindOrder || left.attentionSinceMs - right.attentionSinceMs || left.identity.localeCompare(right.identity);
}

function activityOrder(activity: "running" | "stopping" | "idle" | undefined): number {
  return activity === "running" ? 0 : activity === "stopping" ? 1 : 2;
}

function parseIsoTime(value: string, identity: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Dashboard row ${identity} has an invalid ISO timestamp`);
  return parsed;
}

export function sessionFamilyKey(projectSlug: string, rootSessionId: string): string {
  return `session-family:${projectSlug}:${rootSessionId}`;
}

export function automationOwnerKey(projectSlug: string, automationId: string): string {
  return `automation:${projectSlug}:${automationId}`;
}
