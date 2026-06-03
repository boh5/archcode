import type { PromptContext } from "../types";

export function buildWorkflowIntentGateSection(ctx: PromptContext): string | null {
  if (!isOrchestratorWorkflowPrompt(ctx)) return null;

  return `## Orchestrator Intent Gate: Workflow Upgrades

- Consider a derived full_feature workflow when a research_only workflow now needs implementation/spec execution, or when a quick_fix now needs product/spec/critic gates.
- Before upgrading, use ask_user for explicit confirmation. Never silently upgrade, mutate the source workflow type, or reuse the source orchestrator session.
- After confirmation, call workflow_create with derivedFrom context that names the source workflow, reason, trigger message when available, and handoff summary artifact.
- Put the handoff summary plus artifact_read references for source artifacts in the derived session's first user message so the new orchestrator can read prior context before delegation.`;
}

function isOrchestratorWorkflowPrompt(ctx: PromptContext): boolean {
  return ctx.promptProfileId === "default" && ctx.allowedTools.includes("workflow_create") && ctx.allowedTools.includes("ask_user");
}
