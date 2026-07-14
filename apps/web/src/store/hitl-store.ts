import { createStore } from "zustand/vanilla";
import { useStore } from "zustand/react";
import { useMemo } from "react";
import { hitlIdentityKey, type GlobalSSEHitlRealtimeEvent, type GlobalSSEHitlSnapshotEvent, type HitlView } from "@archcode/protocol";

export { hitlIdentityKey };
export type HitlScope = "project" | "session" | "goal";
export interface ScopedHitlView { projectSlug: string; view: HitlView }

interface HitlStoreState {
  views: Record<string, ScopedHitlView>;
  initializedProjects: Record<string, true>;
  applyRealtimeEvent: (event: GlobalSSEHitlRealtimeEvent) => void;
  applyScopedView: (projectSlug: string, view: HitlView) => void;
  applySnapshot: (event: GlobalSSEHitlSnapshotEvent) => void;
  removeProject: (projectSlug: string) => void;
  invalidateSnapshots: () => void;
  isProjectInitialized: (projectSlug: string) => boolean;
  reset: () => void;
}

export const hitlStore = createStore<HitlStoreState>((set, get) => ({
  views: {}, initializedProjects: {},
  applyRealtimeEvent: (event) => get().applyScopedView(event.projectSlug, event.view),
  applyScopedView: (projectSlug, view) => set((state) => {
    const views = { ...state.views }, key = scopedHitlKey(projectSlug, view);
    if (isVisibleHitlView(view)) views[key] = { projectSlug, view }; else delete views[key];
    return { views };
  }),
  applySnapshot: (event) => set((state) => {
    if (event.projectSlugs.length === 0) return { views: {}, initializedProjects: {} };
    const projects = new Set(event.projectSlugs);
    const views = Object.fromEntries(Object.entries(state.views).filter(([, entry]) => !projects.has(entry.projectSlug)));
    for (const entry of event.entries) if (projects.has(entry.projectSlug) && isVisibleHitlView(entry.view)) views[scopedHitlKey(entry.projectSlug, entry.view)] = entry;
    const initializedProjects = { ...state.initializedProjects }; for (const slug of event.projectSlugs) initializedProjects[slug] = true;
    return { views, initializedProjects };
  }),
  removeProject: (projectSlug) => set((state) => {
    const initializedProjects = { ...state.initializedProjects }; delete initializedProjects[projectSlug];
    return { initializedProjects, views: Object.fromEntries(Object.entries(state.views).filter(([, entry]) => entry.projectSlug !== projectSlug)) };
  }),
  invalidateSnapshots: () => set({ initializedProjects: {} }),
  isProjectInitialized: (projectSlug) => get().initializedProjects[projectSlug] === true,
  reset: () => set({ views: {}, initializedProjects: {} }),
}));

export function useHitlProjectInitialized(projectSlug: string): boolean { return useStore(hitlStore, (state) => state.initializedProjects[projectSlug] === true); }

export function useRealtimeHitl(input: { readonly slug: string; readonly scope: HitlScope; readonly ownerId?: string }): HitlView[] {
  const views = useStore(hitlStore, (state) => state.views);
  return useMemo(() => selectHitlViews(Object.values(views), input), [input.ownerId, input.scope, input.slug, views]);
}

export function useRealtimeHitlProjects(projectSlugs: readonly string[]): HitlView[] {
  const views = useStore(hitlStore, (state) => state.views);
  return useMemo(() => { const allowed = new Set(projectSlugs); return Object.values(views).filter((entry) => allowed.has(entry.projectSlug) && isVisibleHitlView(entry.view)).map((entry) => entry.view).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }, [projectSlugs, views]);
}
export function useRealtimeHitlEntries(projectSlugs: readonly string[]): ScopedHitlView[] {
  const views = useStore(hitlStore, (state) => state.views);
  return useMemo(() => { const allowed = new Set(projectSlugs); return Object.values(views).filter((entry) => allowed.has(entry.projectSlug) && isVisibleHitlView(entry.view)); }, [projectSlugs, views]);
}

export function selectHitlViews(entries: readonly ScopedHitlView[], input: { readonly slug: string; readonly scope: HitlScope; readonly ownerId?: string }): HitlView[] {
  return entries.filter((entry) => entry.projectSlug === input.slug).filter((entry) => input.scope === "project" || (Boolean(input.ownerId) && entry.view.owner.type === input.scope && entry.view.owner.id === input.ownerId)).map((entry) => entry.view).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || hitlIdentityKey(a).localeCompare(hitlIdentityKey(b)));
}

export function isVisibleHitlView(view: Pick<HitlView, "status" | "requiresInspection">): boolean { return view.status === "pending" || view.requiresInspection === true; }

export function scopedHitlKey(projectSlug: string, view: Pick<HitlView, "owner" | "hitlId">): string {
  return `${projectSlug}\0${hitlIdentityKey(view)}`;
}
