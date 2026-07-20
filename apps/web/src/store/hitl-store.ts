import { useMemo } from "react";
import { useStore } from "zustand/react";
import { createStore } from "zustand/vanilla";
import {
  type GlobalSSEHitlRealtimeEvent,
  type GlobalSSEHitlSnapshotEvent,
  type HitlView,
} from "@archcode/protocol";

/**
 * The sole browser-side HITL projection.  `rootSessionId` is transport-derived
 * metadata: the project queue remains the authority and is never mutated here.
 */
export interface ScopedHitlView {
  readonly projectSlug: string;
  readonly ownerSessionId: string;
  readonly rootSessionId: string;
  readonly view: HitlView;
}

interface HitlStoreState {
  readonly views: Record<string, ScopedHitlView>;
  readonly initializedProjects: Record<string, true>;
  applyRealtimeEvent: (event: GlobalSSEHitlRealtimeEvent) => void;
  applySnapshot: (event: GlobalSSEHitlSnapshotEvent) => void;
  /** Reconcile a response against the already-known scoped owner; never infer a root. */
  reconcileView: (projectSlug: string, view: HitlView) => void;
  removeProject: (projectSlug: string) => void;
  invalidateSnapshots: () => void;
  isProjectInitialized: (projectSlug: string) => boolean;
  reset: () => void;
}

function scopedEntryFromRealtime(event: GlobalSSEHitlRealtimeEvent): ScopedHitlView {
  return {
    projectSlug: event.projectSlug,
    ownerSessionId: event.ownerSessionId,
    rootSessionId: event.rootSessionId,
    view: event.view,
  };
}

function scopedEntryFromSnapshot(entry: GlobalSSEHitlSnapshotEvent["entries"][number]): ScopedHitlView {
  return {
    projectSlug: entry.projectSlug,
    ownerSessionId: entry.ownerSessionId,
    rootSessionId: entry.rootSessionId,
    view: entry.view,
  };
}

function writeScopedView(
  views: Record<string, ScopedHitlView>,
  entry: ScopedHitlView,
): Record<string, ScopedHitlView> {
  const next = { ...views };
  const key = scopedHitlKey(entry);
  if (isAttentionVisibleHitlView(entry.view)) next[key] = entry;
  else delete next[key];
  return next;
}

export const hitlStore = createStore<HitlStoreState>((set, get) => ({
  views: {},
  initializedProjects: {},
  applyRealtimeEvent: (event) => set((state) => ({
    views: writeScopedView(state.views, scopedEntryFromRealtime(event)),
  })),
  applySnapshot: (event) => set((state) => {
    if (event.projectSlugs.length === 0) return { views: {}, initializedProjects: {} };

    const refreshedProjects = new Set(event.projectSlugs);
    let views = Object.fromEntries(
      Object.entries(state.views).filter(([, entry]) => !refreshedProjects.has(entry.projectSlug)),
    );
    for (const rawEntry of event.entries) {
      const entry = scopedEntryFromSnapshot(rawEntry);
      if (refreshedProjects.has(entry.projectSlug)) views = writeScopedView(views, entry);
    }

    const initializedProjects = { ...state.initializedProjects };
    for (const slug of event.projectSlugs) initializedProjects[slug] = true;
    return { views, initializedProjects };
  }),
  reconcileView: (projectSlug, view) => set((state) => {
    const previous = state.views[scopedHitlKey({
      projectSlug,
      ownerSessionId: view.owner.id,
      view,
    })];
    if (!previous) return state;
    return {
      views: writeScopedView(state.views, { ...previous, view }),
    };
  }),
  removeProject: (projectSlug) => set((state) => {
    const initializedProjects = { ...state.initializedProjects };
    delete initializedProjects[projectSlug];
    return {
      initializedProjects,
      views: Object.fromEntries(Object.entries(state.views).filter(([, entry]) => entry.projectSlug !== projectSlug)),
    };
  }),
  invalidateSnapshots: () => set({ initializedProjects: {} }),
  isProjectInitialized: (projectSlug) => get().initializedProjects[projectSlug] === true,
  reset: () => set({ views: {}, initializedProjects: {} }),
}));

export function useHitlProjectInitialized(projectSlug: string): boolean {
  return useStore(hitlStore, (state) => state.initializedProjects[projectSlug] === true);
}

/**
 * Stable read-only selector for all attention-visible scoped HITL rows.
 * Consumers use this for Bell, badges, Dashboard, Automation and Session UI.
 */
export function useAttentionVisibleScopedHitl(projectSlugs?: readonly string[]): readonly ScopedHitlView[] {
  const views = useStore(hitlStore, (state) => state.views);
  return useMemo(
    () => selectAttentionVisibleScopedHitl(Object.values(views), projectSlugs),
    [projectSlugs, views],
  );
}

export function selectAttentionVisibleScopedHitl(
  entries: readonly ScopedHitlView[],
  projectSlugs?: readonly string[],
): readonly ScopedHitlView[] {
  const allowedProjects = projectSlugs === undefined ? undefined : new Set(projectSlugs);
  return entries
    .filter((entry) => (allowedProjects === undefined || allowedProjects.has(entry.projectSlug)) && isAttentionVisibleHitlView(entry.view))
    .sort(compareAttentionVisibleHitl);
}

export function selectSessionFamilyHitl(
  entries: readonly ScopedHitlView[],
  projectSlug: string,
  rootSessionId: string,
): readonly ScopedHitlView[] {
  return entries
    .filter((entry) => entry.projectSlug === projectSlug && entry.rootSessionId === rootSessionId)
    .sort(compareAttentionVisibleHitl);
}

export function selectSessionOwnerHitl(
  entries: readonly ScopedHitlView[],
  projectSlug: string,
  ownerSessionId: string,
): readonly ScopedHitlView[] {
  return entries
    .filter((entry) => entry.projectSlug === projectSlug && entry.ownerSessionId === ownerSessionId)
    .sort(compareAttentionVisibleHitl);
}

export function isAttentionVisibleHitlView(view: Pick<HitlView, "status" | "requiresInspection">): boolean {
  return view.status === "pending" || view.requiresInspection === true;
}

export function scopedHitlKey(entry: Pick<ScopedHitlView, "projectSlug" | "ownerSessionId" | "view">): string {
  return `${entry.projectSlug}\0${entry.ownerSessionId}\0${entry.view.hitlId}`;
}

export function scopedHitlIdentity(entry: Pick<ScopedHitlView, "projectSlug" | "ownerSessionId" | "view">): string {
  return `hitl:${entry.projectSlug}:${entry.ownerSessionId}:${entry.view.hitlId}`;
}

export function hitlAttentionPath(entry: ScopedHitlView): string {
  const params = new URLSearchParams({ hitl: entry.view.hitlId });
  if (entry.ownerSessionId !== entry.rootSessionId) params.set("focus", entry.ownerSessionId);
  return `/projects/${encodeURIComponent(entry.projectSlug)}/sessions/${encodeURIComponent(entry.rootSessionId)}?${params.toString()}`;
}

function compareAttentionVisibleHitl(a: ScopedHitlView, b: ScopedHitlView): number {
  const inspectionOrder = Number(b.view.requiresInspection === true) - Number(a.view.requiresInspection === true);
  if (inspectionOrder !== 0) return inspectionOrder;
  return a.view.createdAt.localeCompare(b.view.createdAt) || scopedHitlIdentity(a).localeCompare(scopedHitlIdentity(b));
}
