import type { SessionFamilyActivity } from "@archcode/protocol";
import type { StatusTone, VisualStatusKind } from "./status-visuals";

export interface SessionFamilyVisual {
  readonly kind: VisualStatusKind;
  readonly tone?: StatusTone;
}

export function sessionFamilyVisual(activity: SessionFamilyActivity | undefined): SessionFamilyVisual {
  if (activity === "running") return { kind: "running" };
  if (activity === "stopping") return { kind: "running", tone: "warning" };
  if (activity === "idle") return { kind: "idle" };
  return { kind: "unknown" };
}
