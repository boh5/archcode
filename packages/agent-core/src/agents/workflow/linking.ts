import type { SessionStoreManager } from "../../store/session-store-manager";
import type { SessionStoreState } from "../../store/types";
import type { CreateDerivedWorkflowInput, CreateWorkflowStateInput, WorkflowState } from "./state";
import { WorkflowStateManager } from "./state";

export const WORKFLOW_PARTICIPANT_KEYS = ["orchestrator", "product", "spec", "critic", "foreman"] as const;
export type WorkflowParticipantKey = typeof WORKFLOW_PARTICIPANT_KEYS[number];

/**
 * Link a session as a first-class participant in a workflow.
 * Updates both the workflow's sessionIds and the session's workflowId.
 */
export async function linkSessionToWorkflow(
  workflowId: string,
  participantKey: WorkflowParticipantKey,
  sessionId: string,
  stateManager: WorkflowStateManager,
  storeManager: SessionStoreManager,
): Promise<{ workflow: WorkflowState; session: SessionStoreState }> {
  const state = await stateManager.read(workflowId);
  const workflow = await stateManager.updateSessionIds(workflowId, {
    ...state.sessionIds,
    [participantKey]: sessionId,
  });
  const session = await storeManager.setWorkflowId(sessionId, workflowId);

  return { workflow, session };
}

/**
 * Unlink a session from a workflow's participant map.
 * Removes the participant key from workflow.sessionIds.
 * Does NOT clear the session's workflowId (sessions may still belong to a workflow even if not a named participant).
 */
export async function unlinkSessionFromWorkflow(
  workflowId: string,
  participantKey: WorkflowParticipantKey,
  stateManager: WorkflowStateManager,
): Promise<WorkflowState> {
  const state = await stateManager.read(workflowId);
  const sessionIds = { ...state.sessionIds };
  delete sessionIds[participantKey];

  return await stateManager.updateSessionIds(workflowId, sessionIds);
}

/**
 * Register the orchestrator session when creating a workflow.
 * This is the primary entry point: creates the workflow, links the orchestrator session.
 */
export async function createWorkflowWithOrchestrator(
  input: CreateWorkflowStateInput & { orchestratorSessionId: string },
  stateManager: WorkflowStateManager,
  storeManager: SessionStoreManager,
): Promise<{ workflow: WorkflowState; session: SessionStoreState }> {
  const { orchestratorSessionId, ...createInput } = input;
  const workflow = await stateManager.create(createInput);

  return await linkSessionToWorkflow(
    workflow.id,
    "orchestrator",
    orchestratorSessionId,
    stateManager,
    storeManager,
  );
}

export async function createDerivedWorkflowWithOrchestrator(
  input: CreateDerivedWorkflowInput & { workspaceRoot: string },
  stateManager: WorkflowStateManager,
  storeManager: SessionStoreManager,
): Promise<{
  source: WorkflowState;
  workflow: WorkflowState;
  session: SessionStoreState;
  handoffSummary: string;
  handoffSummaryId: string;
}> {
  const { workspaceRoot, ...deriveInput } = input;
  const derived = await stateManager.createDerived(deriveInput);
  const sessionId = crypto.randomUUID();
  const store = storeManager.create(sessionId, workspaceRoot);

  store.getState().append({
    type: "user-message",
    content: buildDerivedWorkflowInitialMessage(derived),
  });

  const linked = await linkSessionToWorkflow(
    derived.derived.id,
    "orchestrator",
    sessionId,
    stateManager,
    storeManager,
  );

  return {
    source: derived.source,
    workflow: linked.workflow,
    session: linked.session,
    handoffSummary: derived.handoffSummary,
    handoffSummaryId: derived.handoffSummaryId,
  };
}

function buildDerivedWorkflowInitialMessage(input: {
  source: WorkflowState;
  derived: WorkflowState;
  handoffSummary: string;
  handoffSummaryId: string;
}): string {
  const artifactRefs = Object.entries(input.source.artifacts)
    .flatMap(([kind, value]) => {
      const paths = Array.isArray(value) ? value : [value];
      return paths.map((path) => `- ${kind}: artifact_read({ workflowId: "${input.source.id}", path: "${path}" })`);
    });

  return [
    `Start derived workflow ${input.derived.id} from source workflow ${input.source.id}.`,
    "",
    `Handoff summary artifact: ${input.handoffSummaryId}`,
    "",
    input.handoffSummary,
    "## Artifact References",
    ...(artifactRefs.length > 0 ? artifactRefs : ["- No source artifact references recorded."]),
    "",
    "Read source artifacts with artifact_read before delegation. Do not reuse the source workflow session.",
  ].join("\n");
}
