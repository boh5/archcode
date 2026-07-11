import { hitlIdentityKey, type HitlOwnerKey, type HitlProjection, type HitlRecord } from "@archcode/protocol";

import type { GoalState, GoalStateManager } from "../goals/state";
import type { LoopState, LoopStateManager } from "../loops/state";
import type { SessionStoreManager } from "../store/session-store-manager";
import type { SessionSummary } from "../store/helpers";
import { HitlOwnerStore } from "./owner-store";
import { resolveHitlOwnerPath } from "./owner-paths";

export type HitlAggregationScope = "project" | "session" | "goal" | "loop";

export interface HitlAggregationQuery {
  readonly scope: HitlAggregationScope;
  readonly ownerId?: string;
  readonly includeChildren?: boolean;
  readonly status?: "active" | "terminal" | "all";
}

export interface HitlAggregationContext {
  readonly workspaceRoot: string;
  readonly project: { readonly slug: string; readonly name?: string };
  readonly sessions: SessionStoreManager;
  readonly goalState: GoalStateManager;
  readonly loopState: LoopStateManager;
}

interface OwnerDescriptor {
  readonly owner: HitlOwnerKey;
  readonly projectionPath: string[];
  readonly ancestry?: HitlProjection["ancestry"];
}

type SessionTreeLikeNode = { session: SessionSummary; children: SessionTreeLikeNode[] };

export async function aggregateHitlProjections(
  context: HitlAggregationContext,
  query: HitlAggregationQuery,
): Promise<HitlProjection[]> {
  const owners = await collectOwners(context, query);
  const projections: HitlProjection[] = [];

  for (const descriptor of owners) {
    const filePath = await resolveHitlOwnerPath(context.workspaceRoot, descriptor.owner, {
      goalState: context.goalState,
      loopState: context.loopState,
    });
    const store = new HitlOwnerStore(filePath, descriptor.owner);
    for (const record of await store.list()) {
      if (!matchesStatus(record, query.status ?? "active")) continue;
      projections.push(toProjection(context.project, record, descriptor));
    }
  }

  return dedupeProjections(projections);
}

export async function collectKnownHitlOwners(context: HitlAggregationContext): Promise<HitlOwnerKey[]> {
  const sessions = await collectAllSessions(context.sessions, context.workspaceRoot);
  const goals = await context.goalState.listGoals(context.project.slug);
  const loops = await context.loopState.list(context.project.slug);
  return [
    ...sessions.map((session) => ownerKey(context.project.slug, "session", session.sessionId)),
    ...goals.map((goal) => ownerKey(context.project.slug, "goal", goal.id)),
    ...loops.map((loop) => ownerKey(context.project.slug, "loop", loop.loopId)),
  ];
}

export function toHitlProjection(
  project: { readonly slug: string; readonly name?: string },
  record: HitlRecord,
  ancestry?: HitlProjection["ancestry"],
): HitlProjection {
  return {
    hitlId: record.hitlId,
    project: { slug: project.slug, ...(project.name === undefined ? {} : { name: project.name }) },
    owner: record.owner,
    ...(ancestry === undefined ? {} : { ancestry }),
    source: record.source,
    status: record.status,
    displayPayload: record.displayPayload,
    allowedActions: allowedActionsFor(record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.resolvedAt === undefined ? {} : { resolvedAt: record.resolvedAt }),
  };
}

async function collectOwners(context: HitlAggregationContext, query: HitlAggregationQuery): Promise<OwnerDescriptor[]> {
  const sessions = await collectAllSessions(context.sessions, context.workspaceRoot);
  const goals = await context.goalState.listGoals(context.project.slug);
  const loops = await context.loopState.list(context.project.slug);

  switch (query.scope) {
    case "project":
      return [
        ...sessions.map((session) => sessionDescriptor(context.project.slug, session, ["project", context.project.slug, "session", session.sessionId])),
        ...goals.map((goal) => goalDescriptor(context.project.slug, goal, ["project", context.project.slug, "goal", goal.id])),
        ...loops.map((loop) => loopDescriptor(context.project.slug, loop, ["project", context.project.slug, "loop", loop.loopId])),
      ];
    case "session":
      return sessionScopeOwners(context.project.slug, sessions, requiredOwnerId(query), query.includeChildren === true);
    case "goal":
      return goalScopeOwners(context.project.slug, sessions, goals, requiredOwnerId(query), query.includeChildren === true);
    case "loop":
      return loopScopeOwners(context.project.slug, sessions, goals, loops, requiredOwnerId(query), query.includeChildren === true);
  }
}

async function collectAllSessions(manager: SessionStoreManager, workspaceRoot: string): Promise<SessionSummary[]> {
  const roots = await manager.listSessionSummaries(workspaceRoot);
  const byId = new Map<string, SessionSummary>();
  for (const root of roots) {
    byId.set(root.sessionId, root);
    const tree = await manager.buildSessionTree(workspaceRoot, root.sessionId);
    flattenSessionTree(tree.root as SessionTreeLikeNode).forEach((summary) => byId.set(summary.sessionId, summary));
  }
  return [...byId.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

function flattenSessionTree(node: SessionTreeLikeNode): SessionSummary[] {
  const summaries: SessionSummary[] = [node.session];
  for (const child of node.children) summaries.push(...flattenSessionTree(child));
  return summaries;
}

function sessionScopeOwners(projectSlug: string, sessions: SessionSummary[], sessionId: string, includeChildren: boolean): OwnerDescriptor[] {
  const selected = includeChildren
    ? sessions.filter((session) => session.sessionId === sessionId || session.rootSessionId === sessionId || isDescendantOf(session, sessionId, sessions))
    : sessions.filter((session) => session.sessionId === sessionId);
  return selected.map((session) => sessionDescriptor(projectSlug, session, ["session", sessionId, session.sessionId]));
}

function goalScopeOwners(projectSlug: string, sessions: SessionSummary[], goals: GoalState[], goalId: string, includeChildren: boolean): OwnerDescriptor[] {
  const descriptors: OwnerDescriptor[] = [];
  const goal = goals.find((entry) => entry.id === goalId);
  if (goal !== undefined) descriptors.push(goalDescriptor(projectSlug, goal, ["goal", goalId]));

  const directSessions = sessions.filter((session) => session.goalId === goalId);
  const selectedSessions = includeChildren ? includeSessionDescendants(directSessions, sessions) : directSessions;
  descriptors.push(...selectedSessions.map((session) => sessionDescriptor(projectSlug, session, ["goal", goalId, "session", session.sessionId])));
  return descriptors;
}

function loopScopeOwners(
  projectSlug: string,
  sessions: SessionSummary[],
  goals: GoalState[],
  loops: LoopState[],
  loopId: string,
  includeChildren: boolean,
): OwnerDescriptor[] {
  const descriptors: OwnerDescriptor[] = [];
  const loop = loops.find((entry) => entry.loopId === loopId);
  if (loop !== undefined) descriptors.push(loopDescriptor(projectSlug, loop, ["loop", loopId]));

  const loopGoals = goals.filter((goal) => goal.loopId === loopId);
  descriptors.push(...loopGoals.map((goal) => goalDescriptor(projectSlug, goal, ["loop", loopId, "goal", goal.id])));

  const directLoopSessions = sessions.filter((session) => session.loopId === loopId);
  const goalSessions = sessions.filter((session) => loopGoals.some((goal) => goal.id === session.goalId));
  const selectedSessions = includeChildren
    ? includeSessionDescendants([...directLoopSessions, ...goalSessions], sessions)
    : directLoopSessions;
  descriptors.push(...selectedSessions.map((session) => sessionDescriptor(projectSlug, session, loopSessionProjectionPath(loopId, loopGoals, session))));
  return descriptors;
}

function loopSessionProjectionPath(loopId: string, loopGoals: GoalState[], session: SessionSummary): string[] {
  const childGoal = loopGoals.find((goal) => goal.id === session.goalId);
  if (childGoal !== undefined) return ["loop", loopId, "goal", childGoal.id, "session", session.sessionId];
  return ["loop", loopId, "session", session.sessionId];
}

function includeSessionDescendants(seed: SessionSummary[], sessions: SessionSummary[]): SessionSummary[] {
  const selected = new Map(seed.map((session) => [session.sessionId, session]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const session of sessions) {
      if (selected.has(session.sessionId)) continue;
      if (session.parentSessionId !== undefined && selected.has(session.parentSessionId)) {
        selected.set(session.sessionId, session);
        changed = true;
      }
    }
  }
  return [...selected.values()];
}

function isDescendantOf(session: SessionSummary, ancestorId: string, sessions: SessionSummary[]): boolean {
  let current = session.parentSessionId;
  const byId = new Map(sessions.map((entry) => [entry.sessionId, entry]));
  while (current !== undefined) {
    if (current === ancestorId) return true;
    current = byId.get(current)?.parentSessionId;
  }
  return false;
}

function sessionDescriptor(projectSlug: string, session: SessionSummary, projectionPath: string[]): OwnerDescriptor {
  return {
    owner: ownerKey(projectSlug, "session", session.sessionId),
    projectionPath,
    ancestry: withoutUndefined({
      rootSessionId: session.rootSessionId,
      parentSessionId: session.parentSessionId,
      goalId: session.goalId,
      loopId: session.loopId,
      projectionPath,
    }),
  };
}

function goalDescriptor(projectSlug: string, goal: GoalState, projectionPath: string[]): OwnerDescriptor {
  return {
    owner: ownerKey(projectSlug, "goal", goal.id),
    projectionPath,
    ancestry: withoutUndefined({ goalId: goal.id, loopId: goal.loopId, projectionPath }),
  };
}

function loopDescriptor(projectSlug: string, loop: LoopState, projectionPath: string[]): OwnerDescriptor {
  return {
    owner: ownerKey(projectSlug, "loop", loop.loopId),
    projectionPath,
    ancestry: { loopId: loop.loopId, projectionPath },
  };
}

function toProjection(project: { readonly slug: string; readonly name?: string }, record: HitlRecord, descriptor: OwnerDescriptor): HitlProjection {
  return toHitlProjection(project, record, withoutUndefined({
    ...descriptor.ancestry,
    projectionPath: descriptor.projectionPath,
  }));
}

function dedupeProjections(projections: HitlProjection[]): HitlProjection[] {
  const byIdentity = new Map<string, HitlProjection>();
  for (const projection of projections) {
    const key = hitlIdentityKey(projection);
    if (!byIdentity.has(key)) byIdentity.set(key, projection);
  }
  return [...byIdentity.values()].sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt)
    || hitlIdentityKey(left).localeCompare(hitlIdentityKey(right))
  ));
}

function matchesStatus(record: HitlRecord, status: "active" | "terminal" | "all"): boolean {
  if (status === "all") return true;
  if (status === "active") return record.status === "pending" || record.status === "resume_claimed" || record.status === "resume_failed";
  return record.status === "resolved" || record.status === "cancelled";
}

function allowedActionsFor(record: HitlRecord): HitlProjection["allowedActions"] {
  if (record.status === "resume_failed") return ["retry_resume", "cancel"];
  if (record.status !== "pending") return [];
  switch (record.source.type) {
    case "ask_user":
    case "goal_question":
    case "loop_question":
      return ["answer", "cancel"];
    case "tool_permission":
      return ["approve", "deny", "cancel"];
    case "goal_approval":
    case "goal_budget":
    case "loop_approval":
      return ["approve", "deny", "cancel"];
    case "goal_review":
      return ["approve", "deny", "cancel"];
    case "loop_blocker":
    case "loop_retry":
      return ["approve", "cancel"];
  }
}

function requiredOwnerId(query: HitlAggregationQuery): string {
  if (query.ownerId === undefined) throw new Error(`ownerId is required for ${query.scope} HITL aggregation`);
  return query.ownerId;
}

function ownerKey(projectSlug: string, ownerType: HitlOwnerKey["ownerType"], ownerId: string): HitlOwnerKey {
  return { projectSlug, ownerType, ownerId };
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
