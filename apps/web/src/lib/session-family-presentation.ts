import type { ProjectSessionInventoryItem, SessionFamilyActivity } from "@archcode/protocol";
import type { StatusTone, VisualStatusKind } from "./status-visuals";

export interface SessionFamilyVisual {
  readonly kind: VisualStatusKind;
  readonly tone?: StatusTone;
}

export function sessionFamilyVisual(activity: SessionFamilyActivity | undefined): SessionFamilyVisual {
  if (activity === "running") return { kind: "running" };
  if (activity === "resuming") return { kind: "running" };
  if (activity === "waiting_for_human") return { kind: "pending" };
  if (activity === "stopping") return { kind: "running", tone: "warning" };
  if (activity === "idle") return { kind: "idle" };
  return { kind: "unknown" };
}

export function sessionFamilyActivityLabel(activity: SessionFamilyActivity | undefined): string {
  if (activity === "running") return "Running";
  if (activity === "waiting_for_human") return "Waiting";
  if (activity === "resuming") return "Resuming";
  if (activity === "stopping") return "Stopping";
  if (activity === "idle") return "Idle";
  return "Status unavailable";
}

export function sessionInventoryNeedsAttention(
  item: ProjectSessionInventoryItem,
  hasScopedAttention: boolean,
): boolean {
  const status = item.latestExecution?.status;
  return hasScopedAttention || status === "failed" || status === "timed_out" || status === "max_steps";
}

export function sessionInventoryIsActive(
  item: ProjectSessionInventoryItem,
  activity: SessionFamilyActivity | undefined,
  hasScopedAttention: boolean,
): boolean {
  return sessionInventoryNeedsAttention(item, hasScopedAttention)
    || (activity !== undefined && activity !== "idle")
    || item.latestExecution?.status === "running";
}
