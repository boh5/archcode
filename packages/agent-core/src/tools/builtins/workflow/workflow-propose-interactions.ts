import { z } from "zod/v4";
import { TOOL_WORKFLOW_PROPOSE_INTERACTIONS } from "../../names";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import type { AnyToolDescriptor, PermissionDecision, ToolExecutionContext, ToolExecutionResult } from "../../types";
import { emitWorkflowStateChange } from "../../../agents/workflow/events";
import {
  WorkflowInteractionKindSchema,
  WorkflowInteractionSchema,
  WorkflowPathError,
  WorkflowStageSchema,
  WorkflowUuidSchema,
  type WorkflowInteraction,
} from "../../../agents/workflow/state";
import { guardCurrentWorkflow } from "./guard-current-workflow";

const ProposalSourceAgentSchema = z.enum(["product", "spec", "critic", "orchestrator"]);

const WorkflowInteractionProposalSchema = z.strictObject({
  decisionKey: z.string().trim().min(1),
  stage: WorkflowStageSchema,
  sourceAgent: ProposalSourceAgentSchema,
  kind: WorkflowInteractionKindSchema,
  blocking: z.boolean(),
  question: z.string().trim().min(1),
  options: z.array(z.string().trim().min(1)),
  recommendedOption: z.string().trim().min(1).optional(),
  rationale: z.string().trim().min(1),
}).superRefine((proposal, context) => {
  if (proposal.kind === "decision" && proposal.options.length < 2) {
    context.addIssue({
      code: "custom",
      path: ["options"],
      message: "Decision interactions require at least two options",
    });
  }
  if (proposal.recommendedOption && !proposal.options.includes(proposal.recommendedOption)) {
    context.addIssue({
      code: "custom",
      path: ["recommendedOption"],
      message: "recommendedOption must match one of the options",
    });
  }
});

const WorkflowProposeInteractionsInputSchema = z.strictObject({
  workflowId: WorkflowUuidSchema.describe("The current workflow id to update"),
  proposals: z.array(WorkflowInteractionProposalSchema).min(1).describe("Structured workflow interaction proposals to record"),
});

type WorkflowProposeInteractionsInput = z.infer<typeof WorkflowProposeInteractionsInputSchema>;
type WorkflowInteractionProposal = z.infer<typeof WorkflowInteractionProposalSchema>;

export function createWorkflowProposeInteractionsTool(): AnyToolDescriptor {
  return defineTool({
    name: TOOL_WORKFLOW_PROPOSE_INTERACTIONS,
    description: "Propose structured workflow interactions that the Orchestrator may batch and ask the user about.",
    inputSchema: WorkflowProposeInteractionsInputSchema,
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    permissions: [allowProposalSourceRoles],
    execute: async (input: WorkflowProposeInteractionsInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      const guardResult = guardCurrentWorkflow(input.workflowId, ctx, TOOL_WORKFLOW_PROPOSE_INTERACTIONS);
      if (guardResult) return guardResult;

      try {
        const stateManager = ctx.projectContext.workflowState;
        const state = await stateManager.read(input.workflowId);
        const now = new Date().toISOString();
        const requiredInteractions = [...state.requiredInteractions];
        const accepted: Array<{ decisionKey: string; stage: string; action: "created" | "updated"; revision: number }> = [];
        let created = 0;
        let updated = 0;

        for (const proposal of input.proposals) {
          const existingIndex = requiredInteractions.findIndex((interaction) =>
            interaction.decisionKey === proposal.decisionKey && interaction.stage === proposal.stage,
          );
          if (existingIndex === -1) {
            const interaction = buildInteraction(proposal, now);
            requiredInteractions.push(interaction);
            accepted.push({ decisionKey: interaction.decisionKey, stage: interaction.stage, action: "created", revision: interaction.revision });
            created += 1;
            continue;
          }

          const existing = requiredInteractions[existingIndex]!;
          const interaction = WorkflowInteractionSchema.parse({
            ...existing,
            ...proposal,
            id: existing.id,
            status: "proposed",
            answer: undefined,
            resolvedAt: undefined,
            cancelledAt: undefined,
            supersededBy: undefined,
            revision: existing.revision + 1,
          });
          requiredInteractions[existingIndex] = interaction;
          accepted.push({ decisionKey: interaction.decisionKey, stage: interaction.stage, action: "updated", revision: interaction.revision });
          updated += 1;
        }

        const updatedState = await stateManager.updateInteractions(input.workflowId, {
          requiredInteractions,
          resolvedInteractions: state.resolvedInteractions,
        });
        emitWorkflowStateChange(ctx.store, input.workflowId, ["requiredInteractions"]);

        return JSON.stringify({
          workflowId: input.workflowId,
          accepted: accepted.length,
          created,
          updated,
          state: updatedState,
          interactions: accepted,
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

function buildInteraction(proposal: WorkflowInteractionProposal, now: string): WorkflowInteraction {
  return WorkflowInteractionSchema.parse({
    id: crypto.randomUUID(),
    ...proposal,
    status: "proposed",
    createdAt: now,
    revision: 1,
  });
}

function allowProposalSourceRoles(_input: unknown, ctx: ToolExecutionContext): PermissionDecision {
  const agentName = ctx.agentName ?? ctx.store.getState().agentName;
  if (["product", "spec", "critic", "orchestrator"].includes(agentName)) return { outcome: "allow" };
  return {
    outcome: "deny",
    errorCode: "TOOL_WORKFLOW_ROLE_DENIED",
    errorKind: "permission-denied",
    reason: `${TOOL_WORKFLOW_PROPOSE_INTERACTIONS} is only available to Product, Spec, Critic, and Orchestrator roles`,
  };
}

export { WorkflowProposeInteractionsInputSchema, WorkflowInteractionProposalSchema };
