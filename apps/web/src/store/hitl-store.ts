import { createStore } from "zustand/vanilla";
import { useStore } from "zustand/react";
import { useMemo } from "react";
import {
  hitlIdentityKey,
  type GlobalSSEHitlRealtimeEvent,
  type GlobalSSEHitlSnapshotEvent,
  type HitlProjection,
} from "@archcode/protocol";

export { hitlIdentityKey };

export type HitlScope = "project" | "session" | "goal" | "loop";

interface HitlStoreState {
  projections: Record<string, HitlProjection>;
  initializedProjects: Record<string, true>;
  applyRealtimeEvent: (event: GlobalSSEHitlRealtimeEvent) => void;
  applySnapshot: (event: GlobalSSEHitlSnapshotEvent) => void;
  removeProject: (projectSlug: string) => void;
  invalidateSnapshots: () => void;
  isProjectInitialized: (projectSlug: string) => boolean;
  reset: () => void;
}

export const hitlStore = createStore<HitlStoreState>((set, get) => ({
  projections: {},
  initializedProjects: {},
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
  applySnapshot: (event) => set((state) => {
    if (event.projectSlugs.length === 0) {
      return { projections: {}, initializedProjects: {} };
    }

    const snapshotProjects = new Set(event.projectSlugs);
    const projections = Object.fromEntries(
      Object.entries(state.projections).filter(([, projection]) => !snapshotProjects.has(projection.project.slug)),
    );
    for (const projection of event.projections) {
      if (!snapshotProjects.has(projection.project.slug) || !isVisiblePendingHitlStatus(projection.status)) continue;
      projections[hitlIdentityKey(projection)] = projection;
    }

    const initializedProjects = { ...state.initializedProjects };
    for (const projectSlug of event.projectSlugs) initializedProjects[projectSlug] = true;
    return { projections, initializedProjects };
  }),
  removeProject: (projectSlug) => set((state) => {
    const initializedProjects = { ...state.initializedProjects };
    delete initializedProjects[projectSlug];
    return {
      initializedProjects,
      projections: Object.fromEntries(
        Object.entries(state.projections).filter(([, projection]) => projection.project.slug !== projectSlug),
      ),
    };
  }),
  invalidateSnapshots: () => set({ initializedProjects: {} }),
  isProjectInitialized: (projectSlug) => get().initializedProjects[projectSlug] === true,
  reset: () => set({ projections: {}, initializedProjects: {} }),
}));

export function useHitlProjectInitialized(projectSlug: string): boolean {
  return useStore(hitlStore, (state) => state.initializedProjects[projectSlug] === true);
}

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
