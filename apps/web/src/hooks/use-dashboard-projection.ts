import { useMemo } from "react";
import type { DashboardProjection, DashboardScope } from "@archcode/protocol";
import { useDashboardReadProjection } from "../api/queries";
import { useAttentionVisibleScopedHitl } from "../store/hitl-store";
import { sessionRuntimeStore } from "../store/session-runtime-store";
import { useStore } from "zustand/react";
import { deriveDashboardSections } from "../lib/dashboard-projection";

export interface UseDashboardProjectionResult {
  readonly data: DashboardProjection | undefined;
  readonly sections: ReturnType<typeof deriveDashboardSections>;
  readonly isLoading: boolean;
  readonly error: Error | null;
}

/**
 * The only Dashboard data adapter. The REST read model owns Sessions/Goals and
 * Automations; the global stores only contribute live family activity and HITL.
 */
export function useDashboardProjection(scope: DashboardScope): UseDashboardProjectionResult {
  const hitlProjectSlugs = useMemo(
    () => scope.kind === "project" ? [scope.projectSlug] : undefined,
    [scope.kind, scope.kind === "project" ? scope.projectSlug : ""],
  );
  const hitl = useAttentionVisibleScopedHitl(hitlProjectSlugs);
  const runtime = useStore(sessionRuntimeStore);
  const query = useDashboardReadProjection(scope);

  const sections = useMemo(() => deriveDashboardSections({
    read: query.data ?? EMPTY_PROJECTION,
    hitl,
    activityFor: runtime.activityFor,
  }), [hitl, query.data, runtime.activityFor, runtime.families, runtime.initializedProjects]);

  return { data: query.data, sections, isLoading: query.isLoading, error: query.error };
}

const EMPTY_PROJECTION: Pick<DashboardProjection, "sessions" | "automations" | "errors"> = {
  sessions: [], automations: [], errors: [],
};
