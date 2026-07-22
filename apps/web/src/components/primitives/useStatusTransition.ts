import { useEffect, useRef } from "react";
import type { VisualStatusKind } from "../../lib/status-visuals";

export type StatusTransition = "attention" | "complete" | undefined;

/**
 * Returns a one-shot transition only when the same mounted entity changes
 * status. Initial mounts and identity changes remain deliberately static.
 */
export function useStatusTransition(
  identity: string,
  kind: VisualStatusKind,
): StatusTransition {
  const previous = useRef({ identity, kind });
  const isSameEntity = previous.current.identity === identity;
  const didChange = previous.current.kind !== kind;
  const transition = isSameEntity && didChange
    ? kind === "needs_you"
      ? "attention"
      : kind === "completed"
        ? "complete"
        : undefined
    : undefined;

  useEffect(() => {
    previous.current = { identity, kind };
  }, [identity, kind]);

  return transition;
}
