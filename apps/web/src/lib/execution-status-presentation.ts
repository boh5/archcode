import type {
  SessionExecutionInputCheckpoint,
  SessionExecutionRecord,
  ToolChildSessionLinkStatus,
} from "@archcode/protocol";

export type ProductExecutionStatus = "running" | "needs_you" | "completed" | "stopped";

export interface ExecutionStatusPresentation {
  productStatus: ProductExecutionStatus;
  label: string;
  detail?: string;
  continuationExecutionId?: string;
}

type ExecutionStatus = SessionExecutionRecord["status"];

const STOP_DETAILS: Record<Exclude<ExecutionStatus, "running" | "waiting_for_human" | "completed">, string> = {
  max_steps: "Max steps",
  failed: "Failed",
  aborted: "Aborted",
  cancelled: "Cancelled",
  timed_out: "Timed out",
  interrupted: "Interrupted",
};

/**
 * Projects runtime execution facts into the four product states used by the UI.
 * A waiting end reason becomes actionable only while its input checkpoint is
 * unresolved; answered history is presented as received, never as still paused.
 */
export function presentExecutionStatus(
  status: ExecutionStatus,
  checkpoint?: SessionExecutionInputCheckpoint,
): ExecutionStatusPresentation {
  if (status === "running") return { productStatus: "running", label: "Running" };
  if (status === "waiting_for_human") {
    if (checkpoint?.state === "cancelled") {
      return { productStatus: "stopped", label: "Stopped", detail: "Input cancelled" };
    }
    if (checkpoint?.state === "response_received") {
      return { productStatus: "completed", label: "Input received", detail: "Resuming" };
    }
    if (checkpoint?.state === "continuing") {
      return {
        productStatus: "completed",
        label: "Input received",
        detail: "Continuing",
        continuationExecutionId: checkpoint.continuationExecutionId,
      };
    }
    if (checkpoint?.state === "continued") {
      return {
        productStatus: "completed",
        label: "Input received",
        continuationExecutionId: checkpoint.continuationExecutionId,
      };
    }
    return { productStatus: "needs_you", label: "Needs you" };
  }
  if (status === "completed") return { productStatus: "completed", label: "Completed" };
  return { productStatus: "stopped", label: "Stopped", detail: STOP_DETAILS[status] };
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
      return { productStatus: "stopped", label: "Stopped", detail: "Failed" };
    case "timed_out":
      return { productStatus: "stopped", label: "Stopped", detail: "Timed out" };
    case "cancelled":
      return { productStatus: "stopped", label: "Stopped", detail: "Cancelled" };
    case "interrupted":
      return { productStatus: "stopped", label: "Stopped", detail: "Interrupted" };
  }
}
