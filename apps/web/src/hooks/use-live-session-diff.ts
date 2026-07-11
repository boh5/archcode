import { useEffect, useRef } from "react";
import { useDiff } from "../api/queries";
import { useSessionFamilyActivity } from "../store/session-runtime-store";

export function useLiveSessionDiff(slug: string, rootSessionId: string, enabled = true) {
  const activity = useSessionFamilyActivity(slug, rootSessionId);
  const active = activity === "running" || activity === "stopping";
  const query = useDiff(slug, rootSessionId, {
    enabled: enabled && slug.length > 0 && rootSessionId.length > 0,
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
