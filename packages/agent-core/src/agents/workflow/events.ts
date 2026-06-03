import type { WorkflowStateChangeEvent } from "@specra/protocol";
import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../../store/types";

export type WorkflowStateChangedField = WorkflowStateChangeEvent["changed"][number];

export function emitWorkflowStateChange(
  store: StoreApi<SessionStoreState>,
  workflowId: string,
  changed: WorkflowStateChangedField[],
): void {
  store.getState().append({
    type: "workflow.state_change",
    workflowId,
    changed,
    updatedAt: new Date().toISOString(),
  });
}
