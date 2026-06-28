import { WorkflowStateSchema, type WorkflowArtifactKind, type WorkflowState } from "../../../agents/workflow/state";

export interface CompactWorkflowOutputOptions {
  message?: string;
  nextAction?: string;
}

export interface CompactWorkflowOutput {
  workflowId: string;
  id: string;
  title: string;
  type: WorkflowState["type"];
  stage: WorkflowState["stage"];
  status: WorkflowState["status"];
  artifactSummary: {
    total: number;
    kinds: WorkflowArtifactKind[];
    byKind: Partial<Record<WorkflowArtifactKind, number>>;
  };
  interactionSummary: {
    unresolved: number;
    resolved: number;
  };
  retryCount: number;
  maxRetries: number;
  message: string;
  nextAction?: string;
  lastError?: string;
  sessionIds: Record<string, string>;
}

export function formatCompactWorkflowOutput(
  state: WorkflowState,
  options: CompactWorkflowOutputOptions = {},
): CompactWorkflowOutput {
  return {
    workflowId: state.id,
    id: state.id,
    title: state.title,
    type: state.type,
    stage: state.stage,
    status: state.status,
    artifactSummary: summarizeArtifacts(state),
    interactionSummary: summarizeInteractions(state),
    retryCount: state.retryCount,
    maxRetries: state.maxRetries,
    message: options.message ?? defaultMessage(state),
    ...(options.nextAction ? { nextAction: options.nextAction } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
    sessionIds: state.sessionIds,
  };
}

export function formatCompactWorkflowJsonOutput(
  output: string,
  options?: CompactWorkflowOutputOptions,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }

  const state = WorkflowStateSchema.safeParse(parsed);
  if (!state.success) return undefined;
  return JSON.stringify(formatCompactWorkflowOutput(state.data, options), null, 2);
}

function summarizeArtifacts(state: WorkflowState): CompactWorkflowOutput["artifactSummary"] {
  const byKind: Partial<Record<WorkflowArtifactKind, number>> = {};
  let total = 0;

  for (const [kind, value] of Object.entries(state.artifacts) as Array<[WorkflowArtifactKind, string | string[] | undefined]>) {
    if (value === undefined) continue;
    const count = Array.isArray(value) ? value.length : 1;
    if (count === 0) continue;
    byKind[kind] = count;
    total += count;
  }

  return {
    total,
    kinds: Object.keys(byKind) as WorkflowArtifactKind[],
    byKind,
  };
}

function summarizeInteractions(state: WorkflowState): CompactWorkflowOutput["interactionSummary"] {
  const unresolved = state.requiredInteractions.filter((interaction) =>
    interaction.status === "proposed" || interaction.status === "requested"
  ).length;

  return {
    unresolved,
    resolved: state.resolvedInteractions.length,
  };
}

function defaultMessage(state: WorkflowState): string {
  return `Workflow ${state.id} is ${state.status} at ${state.stage}.`;
}
