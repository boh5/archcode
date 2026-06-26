import { z } from "zod/v4";
import { TOOL_WORKFLOW_REQUEST_INTERACTIONS } from "../../names";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import type { AnyToolDescriptor, AskUserAnswer, AskUserQuestionOption, PermissionDecision, ToolExecutionContext, ToolExecutionResult } from "../../types";
import { emitWorkflowStateChange } from "../../../agents/workflow/events";
import { archiveInteractions } from "../../../agents/workflow/interactions-archive";
import {
  WorkflowPathError,
  WorkflowStageSchema,
  WorkflowUuidSchema,
  type WorkflowInteraction,
} from "../../../agents/workflow/state";
import { guardCurrentWorkflow } from "./guard-current-workflow";

const WorkflowRequestInteractionsInputSchema = z.strictObject({
  workflowId: WorkflowUuidSchema.describe("The current workflow id to update"),
  stage: WorkflowStageSchema.optional().describe("Stage whose unresolved interactions should be requested. Defaults to the workflow's current stage."),
});

type WorkflowRequestInteractionsInput = z.infer<typeof WorkflowRequestInteractionsInputSchema>;

export function createWorkflowRequestInteractionsTool(): AnyToolDescriptor {
  return defineTool({
    name: TOOL_WORKFLOW_REQUEST_INTERACTIONS,
    description: "Batch unresolved workflow interactions for the current stage into one user request and persist the answers.",
    inputSchema: WorkflowRequestInteractionsInputSchema,
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    permissions: [allowOrchestratorOnly],
    execute: async (input: WorkflowRequestInteractionsInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      const guardResult = guardCurrentWorkflow(input.workflowId, ctx, TOOL_WORKFLOW_REQUEST_INTERACTIONS);
      if (guardResult) return guardResult;
      if (!ctx.askUser) {
        return createToolErrorResult({ kind: "cancelled", message: `${TOOL_WORKFLOW_REQUEST_INTERACTIONS} requires askUser transport` });
      }
      if (ctx.abort.aborted) {
        return createToolErrorResult({ kind: "cancelled", message: `${TOOL_WORKFLOW_REQUEST_INTERACTIONS} was aborted` });
      }

      try {
        const stateManager = ctx.projectContext.workflowState;
        const state = await stateManager.read(input.workflowId);
        const stage = input.stage ?? state.stage;
        const targets = selectPendingInteractions(state.requiredInteractions, stage);
        if (targets.length === 0) {
          return JSON.stringify({
            workflowId: input.workflowId,
            stage,
            requested: 0,
            resolved: 0,
            cancelled: 0,
            pending: 0,
            message: "no interactions to request",
          }, null, 2);
        }

        const requestedIds = new Set(targets.map((interaction) => interaction.id));
        let requiredInteractions = state.requiredInteractions.map((interaction) =>
          requestedIds.has(interaction.id) && (interaction.status === "proposed" || interaction.status === "cancelled")
            ? { ...interaction, status: "requested" as const, cancelledAt: undefined }
            : interaction,
        );
        let resolvedInteractions = [...state.resolvedInteractions];

        const requestResult = await ctx.askUser({
          toolName: ctx.toolName,
          toolCallId: ctx.toolCallId,
          questionType: "decision",
          questions: targets.map(toAskUserQuestion),
          context: {
            workflowId: input.workflowId,
            stage,
            decisionKeys: targets.map((interaction) => interaction.decisionKey),
          },
          abortSignal: ctx.abort,
        });

        const now = new Date().toISOString();
        if ("isError" in requestResult) {
          requiredInteractions = requiredInteractions.map((interaction) =>
            requestedIds.has(interaction.id)
              ? { ...interaction, status: "cancelled" as const, cancelledAt: now }
              : interaction,
          );
          const updatedState = await stateManager.updateInteractions(input.workflowId, { requiredInteractions, resolvedInteractions });
          const archive = await archiveInteractions({ workflow: updatedState, artifacts: ctx.projectContext.artifacts });
          emitWorkflowStateChange(ctx.store, input.workflowId, ["requiredInteractions"]);
          return JSON.stringify({
            ...summary(input.workflowId, stage, targets.length, 0, targets.length, 0, requestResult.reason),
            archive,
          }, null, 2);
        }

        const answerById = new Map<string, AskUserAnswer>();
        targets.forEach((interaction, index) => {
          answerById.set(interaction.id, requestResult.answers[index] ?? []);
        });

        const resolvedIds = new Set<string>();
        for (const interaction of targets) {
          const answer = answerById.get(interaction.id) ?? [];
          if (answer.length === 0) continue;
          resolvedIds.add(interaction.id);
          resolvedInteractions = upsertResolvedInteraction(resolvedInteractions, {
            ...interaction,
            status: "resolved",
            answer: answer.join(", "),
            resolvedAt: now,
            cancelledAt: undefined,
          });
        }

        requiredInteractions = requiredInteractions.flatMap((interaction) => {
          if (!requestedIds.has(interaction.id)) return [interaction];
          if (resolvedIds.has(interaction.id)) return [];
          return [{ ...interaction, status: "requested" as const }];
        });
        const pending = targets.length - resolvedIds.size;

        const updatedState = await stateManager.updateInteractions(input.workflowId, { requiredInteractions, resolvedInteractions });
        const archive = await archiveInteractions({ workflow: updatedState, artifacts: ctx.projectContext.artifacts });
        emitWorkflowStateChange(ctx.store, input.workflowId, ["requiredInteractions", "resolvedInteractions"]);

        return JSON.stringify({
          ...summary(input.workflowId, stage, targets.length, resolvedIds.size, 0, pending),
          archive,
        }, null, 2);
      } catch (error) {
        if (error instanceof WorkflowPathError) {
          return createToolErrorResult({ kind: "workspace", code: "TOOL_WORKFLOW_INVALID_ID", message: error.message });
        }
        return createToolErrorResult({ kind: "execution", error: error instanceof Error ? error : new Error(String(error)) });
      }
    },
  });
}

function selectPendingInteractions(interactions: readonly WorkflowInteraction[], stage: string): WorkflowInteraction[] {
  const selected = new Map<string, WorkflowInteraction>();
  for (const interaction of interactions) {
    if (interaction.stage !== stage) continue;
    if (interaction.status !== "proposed" && interaction.status !== "requested" && interaction.status !== "cancelled") continue;
    const existing = selected.get(interaction.decisionKey);
    if (!existing || compareInteractions(existing, interaction) < 0) selected.set(interaction.decisionKey, interaction);
  }
  return [...selected.values()].sort(compareInteractions);
}

function compareInteractions(left: WorkflowInteraction, right: WorkflowInteraction): number {
  const leftCreated = left.createdAt ?? "";
  const rightCreated = right.createdAt ?? "";
  if (leftCreated !== rightCreated) return leftCreated.localeCompare(rightCreated);
  return left.decisionKey.localeCompare(right.decisionKey);
}

function toAskUserQuestion(interaction: WorkflowInteraction) {
  return {
    header: interaction.decisionKey.slice(0, 30),
    question: `${interaction.question}\n\nRationale: ${interaction.rationale}`,
    options: toAskUserOptions(interaction),
    custom: interaction.options.length === 0,
    multiple: false,
  };
}

function toAskUserOptions(interaction: WorkflowInteraction): AskUserQuestionOption[] {
  return interaction.options.map((option) => ({
    label: option === interaction.recommendedOption ? `${option} (Recommended)` : option,
    description: option === interaction.recommendedOption ? `${option} — recommended by ${interaction.sourceAgent}` : option,
  }));
}

function upsertResolvedInteraction(interactions: WorkflowInteraction[], resolved: WorkflowInteraction): WorkflowInteraction[] {
  const existingIndex = interactions.findIndex((interaction) =>
    interaction.decisionKey === resolved.decisionKey && interaction.stage === resolved.stage,
  );
  if (existingIndex === -1) return [...interactions, resolved];
  const next = [...interactions];
  next[existingIndex] = resolved;
  return next;
}

function summary(workflowId: string, stage: string, requested: number, resolved: number, cancelled: number, pending: number, cancellationReason?: string) {
  return {
    workflowId,
    stage,
    requested,
    resolved,
    cancelled,
    pending,
    ...(cancellationReason ? { cancellationReason } : {}),
  };
}

function allowOrchestratorOnly(_input: unknown, ctx: ToolExecutionContext): PermissionDecision {
  const agentName = ctx.agentName ?? ctx.store.getState().agentName;
  if (agentName === "orchestrator") return { outcome: "allow" };
  return {
    outcome: "deny",
    errorCode: "TOOL_WORKFLOW_ROLE_DENIED",
    errorKind: "permission-denied",
    reason: `${TOOL_WORKFLOW_REQUEST_INTERACTIONS} is only available to the Orchestrator role`,
  };
}

export { WorkflowRequestInteractionsInputSchema };
