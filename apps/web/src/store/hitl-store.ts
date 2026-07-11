import { createStore } from "zustand/vanilla";
import { useStore } from "zustand/react";
import { useMemo } from "react";
import { hitlIdentityKey, type GlobalSSEHitlRealtimeEvent, type HitlProjection } from "@archcode/protocol";

export { hitlIdentityKey };

export type HitlScope = "project" | "session" | "goal" | "loop";

interface HitlStoreState {
  projections: Record<string, HitlProjection>;
  applyRealtimeEvent: (event: GlobalSSEHitlRealtimeEvent) => void;
  applySnapshotReset: (projectSlugs: readonly string[]) => void;
  resetProject: (projectSlug: string) => void;
}

export const hitlStore = createStore<HitlStoreState>((set) => ({
  projections: {},
  applyRealtimeEvent: (event) => set((state) => {
    const next = { ...state.projections };
    const key = hitlIdentityKey(event.projection);
    if (isVisiblePendingHitlStatus(event.projection.status)) {
      next[key] = event.projection;
    } else {
      delete next[key];
    }
    return { projections: next };
  }),
  applySnapshotReset: (projectSlugs) => set((state) => {
    if (projectSlugs.length === 0) return { projections: {} };
    const projects = new Set(projectSlugs);
    return {
      projections: Object.fromEntries(
        Object.entries(state.projections).filter(([, projection]) => !projects.has(projection.project.slug)),
      ),
    };
  }),
  resetProject: (projectSlug) => set((state) => ({
    projections: Object.fromEntries(
      Object.entries(state.projections).filter(([, projection]) => projection.project.slug !== projectSlug),
    ),
  })),
}));

export function useRealtimeHitl(input: {
  readonly slug: string;
  readonly scope: HitlScope;
  readonly ownerId?: string;
  readonly includeChildren?: boolean;
}): HitlProjection[] {
  const projectionsById = useStore(hitlStore, (state) => state.projections);
  const { slug, scope, ownerId, includeChildren } = input;
  return useMemo(
    () => selectHitlProjections(Object.values(projectionsById), { slug, scope, ownerId, includeChildren }),
    [includeChildren, ownerId, projectionsById, scope, slug],
  );
}

export function selectHitlProjections(
  projections: readonly HitlProjection[],
  input: {
    readonly slug: string;
    readonly scope: HitlScope;
    readonly ownerId?: string;
    readonly includeChildren?: boolean;
  },
): HitlProjection[] {
  const ownerId = input.ownerId;
  const selected = projections.filter((projection) => {
    if (projection.project.slug !== input.slug) return false;
    if (input.scope === "project") return true;
    if (!ownerId) return false;
    if (projection.owner.ownerType === input.scope && projection.owner.ownerId === ownerId) return true;
    if (input.includeChildren !== true) return false;
    return isDescendantProjection(projection, input.scope, ownerId);
  });
  return selected.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || hitlIdentityKey(left).localeCompare(hitlIdentityKey(right)));
}

export function isVisiblePendingHitlStatus(status: HitlProjection["status"]): boolean {
  return status === "pending" || status === "resume_failed";
}

function isDescendantProjection(projection: HitlProjection, scope: Exclude<HitlScope, "project">, ownerId: string): boolean {
  const ancestry = projection.ancestry;
  if (scope === "session") {
    if (ancestry?.rootSessionId === ownerId || ancestry?.parentSessionId === ownerId) return true;
    return ancestry?.ancestorSessionIds?.includes(ownerId) ?? false;
  }
  if (scope === "goal") return ancestry?.goalId === ownerId || sourceGoalId(projection) === ownerId;
  if (scope === "loop") return ancestry?.loopId === ownerId || sourceLoopId(projection) === ownerId;
  return false;
}

function sourceGoalId(projection: HitlProjection): string | undefined {
  switch (projection.source.type) {
    case "goal_approval":
    case "goal_review":
    case "goal_budget":
    case "goal_question":
      return projection.source.goalId;
    default:
      return undefined;
  }
}

function sourceLoopId(projection: HitlProjection): string | undefined {
  switch (projection.source.type) {
    case "loop_approval":
    case "loop_blocker":
    case "loop_retry":
    case "loop_question":
      return projection.source.loopId;
    default:
      return undefined;
  }
}
