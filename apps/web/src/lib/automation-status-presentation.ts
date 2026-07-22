import type { AutomationInvocationStatus, AutomationStatus } from "@archcode/protocol";
import type { VisualStatusKind } from "./status-visuals";

export function automationVisualKind(status: AutomationStatus): VisualStatusKind {
  if (status === "active") return "enabled";
  if (status === "paused") return "paused";
  return "disabled";
}

const AUTOMATION_STATUS_LABEL: Record<AutomationStatus, string> = {
  active: "Active",
  paused: "Paused",
  disabled: "Disabled",
};

const AUTOMATION_INVOCATION_STATUS_LABEL: Record<AutomationInvocationStatus, string> = {
  pending: "Pending",
  dispatched: "Dispatched",
  failed: "Failed",
  cancelled: "Cancelled",
  missed: "Missed",
};

export function automationStatusLabel(status: AutomationStatus): string {
  return AUTOMATION_STATUS_LABEL[status];
}

export function automationInvocationStatusLabel(status: AutomationInvocationStatus): string {
  return AUTOMATION_INVOCATION_STATUS_LABEL[status];
}
