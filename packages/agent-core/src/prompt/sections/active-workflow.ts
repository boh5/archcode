import {
  TOOL_ARTIFACT_READ,
  TOOL_ARTIFACT_WRITE,
  TOOL_WORKFLOW_CREATE,
  TOOL_WORKFLOW_READ,
  TOOL_WORKFLOW_TASK_CHECK,
  TOOL_WORKFLOW_UPDATE_STAGE,
} from "../../tools/names";
import { formatResolvedDecisionConstraints } from "../../agents/workflow/interactions-archive";
import type { ActiveWorkflowPromptContext, PromptContext } from "../types";

const WORKFLOW_CAPABLE_TOOLS = new Set<string>([
  TOOL_WORKFLOW_CREATE,
  TOOL_WORKFLOW_READ,
  TOOL_WORKFLOW_UPDATE_STAGE,
  TOOL_WORKFLOW_TASK_CHECK,
  TOOL_ARTIFACT_READ,
  TOOL_ARTIFACT_WRITE,
]);

export function hasWorkflowTools(allowedTools: readonly string[]): boolean {
  return allowedTools.some((tool) => WORKFLOW_CAPABLE_TOOLS.has(tool));
}

export function buildActiveWorkflowSection(ctx: PromptContext): string | null {
  if (ctx.activeWorkflow === undefined || !hasWorkflowTools(ctx.allowedTools)) return null;
  return formatActiveWorkflowBlock(ctx.activeWorkflow);
}

export function formatActiveWorkflowBlock(workflow: ActiveWorkflowPromptContext): string {
  const sections = [[
    "## Active Workflow",
    "",
    `- Workflow ID: ${workflow.id}`,
    `- Title: ${workflow.title}`,
    `- Type: ${workflow.type}`,
    `- Stage: ${workflow.stage}`,
    `- Status: ${workflow.status}`,
    "",
    "Rules:",
    `- Use the exact workflow UUID \`${workflow.id}\` for this active workflow in all workflow and artifact tool calls.`,
    "- Never invent workflow IDs.",
    "- Never use `default`, a slug, or a title as a workflow ID.",
    "- Use any other workflow UUID only when an explicit read reference provides that UUID.",
  ].join("\n")];

  const resolvedDecisionConstraints = formatResolvedDecisionConstraints(workflow.resolvedInteractions ?? []);
  if (resolvedDecisionConstraints !== null) sections.push(resolvedDecisionConstraints);

  return sections.join("\n\n");
}
