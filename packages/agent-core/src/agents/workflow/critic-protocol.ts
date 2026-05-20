import type { WorkflowStage, WorkflowState, WorkflowStateManager } from "./state";

export type CriticDecision = "approved" | "changes_requested" | "rejected";

export interface CriticDecisionInput {
  workflowId: string;
  decision: CriticDecision;
  criticReportPath?: string;
  currentStage: WorkflowStage;
}

export interface CriticDecisionResult {
  newState: WorkflowState;
  transitionDescription: string;
}

export class CriticDecisionError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly currentStage: WorkflowStage,
    public readonly decision: CriticDecision,
  ) {
    super(`Unsupported critic decision for workflow ${workflowId}: ${decision} at ${currentStage}`);
    this.name = "CriticDecisionError";
  }
}

export async function processCriticDecision(
  input: CriticDecisionInput,
  stateManager: WorkflowStateManager,
): Promise<CriticDecisionResult> {
  if (input.criticReportPath) {
    const state = await stateManager.read(input.workflowId);
    await stateManager.updateArtifacts(input.workflowId, addCriticReportPath(state, input.criticReportPath));
  }

  if (input.decision === "rejected") {
    const newState = await stateManager.fail(
      input.workflowId,
      buildCriticFailureMessage(input, "Critic rejected workflow output"),
    );
    return { newState, transitionDescription: "critic rejected; workflow failed" };
  }

  if (input.decision === "approved") {
    return processApproval(input, stateManager);
  }

  return processChangesRequested(input, stateManager);
}

async function processApproval(
  input: CriticDecisionInput,
  stateManager: WorkflowStateManager,
): Promise<CriticDecisionResult> {
  if (input.currentStage === "critic_prd_review") {
    const newState = await stateManager.updateStage(input.workflowId, "spec_drafting");
    return { newState, transitionDescription: "critic approved PRD; advancing to SPEC drafting" };
  }

  if (input.currentStage === "critic_spec_review") {
    const newState = await stateManager.updateStage(input.workflowId, "awaiting_user_approval");
    return {
      newState,
      transitionDescription: "critic approved SPEC/TASKS; awaiting explicit user approval",
    };
  }

  throw new CriticDecisionError(input.workflowId, input.currentStage, input.decision);
}

async function processChangesRequested(
  input: CriticDecisionInput,
  stateManager: WorkflowStateManager,
): Promise<CriticDecisionResult> {
  const producerStage = producerStageFor(input);
  if (!producerStage) {
    throw new CriticDecisionError(input.workflowId, input.currentStage, input.decision);
  }

  const retried = await stateManager.incrementRetryCount(input.workflowId);
  if (retried.retryCount >= retried.maxRetries) {
    const newState = await stateManager.fail(
      input.workflowId,
      buildCriticFailureMessage(input, `Critic requested changes but retry limit was reached (${retried.retryCount}/${retried.maxRetries})`),
    );
    return { newState, transitionDescription: "critic requested changes; retry limit reached" };
  }

  const newState = await stateManager.updateStage(input.workflowId, producerStage);
  return {
    newState,
    transitionDescription: `critic requested changes; retry ${retried.retryCount}/${retried.maxRetries} returning to ${producerStage}`,
  };
}

function producerStageFor(input: CriticDecisionInput): WorkflowStage | undefined {
  if (input.currentStage === "critic_prd_review") return "product_drafting";
  if (input.currentStage === "critic_spec_review") return "spec_drafting";
  return undefined;
}

function addCriticReportPath(
  state: WorkflowState,
  criticReportPath: string,
): WorkflowState["artifacts"] {
  const existing = state.artifacts.CRITIC_REPORT;
  const paths = Array.isArray(existing) ? existing : existing ? [existing] : [];
  return { ...state.artifacts, CRITIC_REPORT: [...new Set([...paths, criticReportPath])] };
}

function buildCriticFailureMessage(input: CriticDecisionInput, message: string): string {
  return input.criticReportPath ? `${message}. See ${input.criticReportPath}` : message;
}
