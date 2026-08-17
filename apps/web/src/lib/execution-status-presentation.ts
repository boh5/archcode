import type {
  SessionExecutionRecord,
  ToolChildSessionLinkStatus,
} from "@archcode/protocol";
import type { VisualStatusKind } from "./status-visuals";

export type ProductExecutionStatus =
  | "running"
  | "needs_you"
  | "waiting_on_child"
  | "resuming"
  | "completed"
  | "failed"
  | "stopped";

export interface ExecutionStatusPresentation {
  productStatus: ProductExecutionStatus;
  label: string;
  detail?: string;
}

type ExecutionStatus = SessionExecutionRecord["status"];

const STOP_DETAILS: Record<
  Exclude<ExecutionStatus, "running" | "suspended" | "completed" | "failed" | "timed_out" | "max_steps">,
  string
> = {
  aborted: "Aborted",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

export function presentExecutionStatus(
  record: SessionExecutionRecord,
): ExecutionStatusPresentation {
  if (record.status === "running")
    return { productStatus: "running", label: "Running" };
  if (record.status === "suspended") {
    switch (record.suspension.kind) {
      case "hitl":
        return { productStatus: "needs_you", label: "Needs you" };
      case "child_dependency":
        return { productStatus: "waiting_on_child", label: "Waiting on child" };
      case "resume_pending":
        return { productStatus: "resuming", label: "Resuming" };
    }
  }
  if (record.status === "completed")
    return { productStatus: "completed", label: "Completed" };
  if (record.status === "failed")
    return { productStatus: "failed", label: "Failed" };
  if (record.status === "timed_out")
    return { productStatus: "failed", label: "Failed", detail: "Timed out" };
  if (record.status === "max_steps")
    return { productStatus: "failed", label: "Failed", detail: "Max steps" };
  return {
    productStatus: "stopped",
    label: "Stopped",
    detail: STOP_DETAILS[record.status],
  };
}

export function presentChildExecutionStatus(
  status: ToolChildSessionLinkStatus,
): ExecutionStatusPresentation {
  switch (status) {
    case "linked":
      return { productStatus: "running", label: "Running", detail: "Starting" };
    case "running":
      return { productStatus: "running", label: "Running" };
    case "waiting_for_human":
      return { productStatus: "needs_you", label: "Needs you" };
    case "cancelling":
      return { productStatus: "running", label: "Running", detail: "Stopping" };
    case "completed":
      return { productStatus: "completed", label: "Completed" };
    case "failed":
      return { productStatus: "failed", label: "Failed" };
    case "timed_out":
      return {
        productStatus: "failed",
        label: "Failed",
        detail: "Timed out",
      };
    case "cancelled":
      return {
        productStatus: "stopped",
        label: "Stopped",
        detail: "Cancelled",
      };
    case "interrupted":
      return {
        productStatus: "stopped",
        label: "Stopped",
        detail: "Interrupted",
      };
  }
}

export function executionVisualKind(
  record: SessionExecutionRecord,
): VisualStatusKind {
  const presentation = presentExecutionStatus(record);
  switch (presentation.productStatus) {
    case "waiting_on_child":
      return "blocked";
    case "resuming":
      return "loading";
    case "needs_you":
      return "needs_you";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
  }
}

export function childExecutionVisualKind(
  status: ToolChildSessionLinkStatus,
): VisualStatusKind {
  const presentation = presentChildExecutionStatus(status);
  if (presentation.productStatus === "needs_you") return "needs_you";
  if (presentation.productStatus === "running") return "running";
  if (presentation.productStatus === "completed") return "completed";
  if (presentation.productStatus === "failed") return "failed";
  return "stopped";
}
