import type {
  GlobalSSESessionRuntimeChangedEvent,
  GlobalSSESessionRuntimeSnapshotEvent,
  SessionFamilyActivity,
  SessionFamilyRuntimeProjection,
} from "@archcode/protocol";
import { useStore } from "zustand/react";
import { createStore } from "zustand/vanilla";

export interface SessionRuntimeStoreState {
  families: Record<string, SessionFamilyRuntimeProjection>;
  initializedProjects: Record<string, true>;
  applySnapshot: (event: GlobalSSESessionRuntimeSnapshotEvent) => void;
  applyChange: (event: GlobalSSESessionRuntimeChangedEvent) => void;
  removeProject: (projectSlug: string) => void;
  invalidateSnapshots: () => void;
  isProjectInitialized: (projectSlug: string) => boolean;
  activityFor: (projectSlug: string, rootSessionId: string) => SessionFamilyActivity | undefined;
  reset: () => void;
}

export function runtimeFamilyKey(projectSlug: string, rootSessionId: string): string {
  return `${projectSlug}\u0000${rootSessionId}`;
}

export const sessionRuntimeStore = createStore<SessionRuntimeStoreState>((set, get) => ({
  families: {},
  initializedProjects: {},

  applySnapshot: (event) => set((state) => {
    if (event.projectSlugs.length === 0) {
      return { families: {}, initializedProjects: {} };
    }

    const resetProjects = new Set(event.projectSlugs);
    const families = Object.fromEntries(
      Object.entries(state.families).filter(([, family]) => !resetProjects.has(family.projectSlug)),
    );

    for (const family of event.families) {
      if (!resetProjects.has(family.projectSlug) || family.activity === "idle") continue;
      families[runtimeFamilyKey(family.projectSlug, family.rootSessionId)] = family;
    }

    const initializedProjects = { ...state.initializedProjects };
    for (const projectSlug of event.projectSlugs) initializedProjects[projectSlug] = true;
    return { families, initializedProjects };
  }),

  applyChange: (event) => set((state) => {
    const families = { ...state.families };
    const key = runtimeFamilyKey(event.projectSlug, event.rootSessionId);
    if (event.activity === "idle") {
      delete families[key];
    } else {
      families[key] = {
        projectSlug: event.projectSlug,
        rootSessionId: event.rootSessionId,
        activity: event.activity,
        ...(event.steerTargetExecutionId
          ? { steerTargetExecutionId: event.steerTargetExecutionId }
          : {}),
      };
    }
    return { families };
  }),

  removeProject: (projectSlug) => set((state) => {
    const initializedProjects = { ...state.initializedProjects };
    delete initializedProjects[projectSlug];
    return {
      initializedProjects,
      families: Object.fromEntries(
        Object.entries(state.families).filter(([, family]) => family.projectSlug !== projectSlug),
      ),
    };
  }),

  invalidateSnapshots: () => set({ initializedProjects: {} }),
  isProjectInitialized: (projectSlug) => get().initializedProjects[projectSlug] === true,
  activityFor: (projectSlug, rootSessionId) => {
    if (get().initializedProjects[projectSlug] !== true) return undefined;
    return get().families[runtimeFamilyKey(projectSlug, rootSessionId)]?.activity ?? "idle";
  },
  reset: () => set({ families: {}, initializedProjects: {} }),
}));

export function useSessionRuntimeInitialized(projectSlug: string): boolean {
  return useStore(sessionRuntimeStore, (state) => state.initializedProjects[projectSlug] === true);
}

export function useSessionRuntimeFamilies(): Record<string, SessionFamilyRuntimeProjection> {
  return useStore(sessionRuntimeStore, (state) => state.families);
}

export function useSessionFamilyActivity(
  projectSlug: string,
  rootSessionId: string,
): SessionFamilyActivity | undefined {
  return useStore(sessionRuntimeStore, (state) => {
    if (state.initializedProjects[projectSlug] !== true) return undefined;
    return state.families[runtimeFamilyKey(projectSlug, rootSessionId)]?.activity ?? "idle";
  });
}

export function useSessionFamilySteerTargetExecutionId(
  projectSlug: string,
  rootSessionId: string,
): string | undefined {
  return useStore(sessionRuntimeStore, (state) => {
    if (state.initializedProjects[projectSlug] !== true) return undefined;
    return state.families[runtimeFamilyKey(projectSlug, rootSessionId)]?.steerTargetExecutionId;
  });
}
