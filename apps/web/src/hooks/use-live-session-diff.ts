import { useEffect, useRef } from "react";
import { useDiff } from "../api/queries";
import { useSessionFamilyActivity } from "../store/session-runtime-store";

export function useLiveSessionDiff(
  slug: string,
  targetSessionId: string,
  options: { enabled?: boolean; activityRootSessionId?: string } = {},
) {
  const enabled = options.enabled ?? true;
  const activityRootSessionId = options.activityRootSessionId ?? targetSessionId;
  const activity = useSessionFamilyActivity(slug, activityRootSessionId);
  const active = activity !== undefined && activity !== "idle";
  const query = useDiff(slug, targetSessionId, {
    enabled: enabled && slug.length > 0 && targetSessionId.length > 0,
    refetchInterval: enabled && active ? 2_000 : false,
    refetchOnMount: "always",
  });
  const wasActive = useRef(active);

  useEffect(() => {
    const executionStopped = wasActive.current && !active;
    wasActive.current = active;
    if (enabled && executionStopped) void query.refetch();
  }, [active, enabled, query.refetch]);

  return query;
}
