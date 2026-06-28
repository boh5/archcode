import type { PromptContext } from "../types";

export function buildWorkflowIntentGateSection(ctx: PromptContext): string | null {
  if (!isOrchestratorWorkflowPrompt(ctx)) return null;

  return `## Workflow MVP Orchestration

### Workflow type selection
- Use workflow_create when the user asks for async/long-running work, explicit workflow coordination, artifact-driven planning, implementation with gates, or durable stage/status tracking.
- Choose research_only for investigation or answer synthesis that should produce RESEARCH without source edits.
- Choose quick_fix for narrow, low-risk fixes that can go through quick_analysis -> quick_patch -> quick_verify without PRD/SPEC/Critic gates.
- Choose full_feature for new features, broad refactors, ambiguous requirements, multi-file execution, user approval gates, or anything that needs PRD, SPEC, TASKS, Critic, and Foreman execution.

### Stage map and lifecycle reminders
- Use workflow_update_stage for every business-stage move. Never invent terminal stages; completion, pause, and failure are lifecycle status, not stage names.
- Stage paths: research_only idle -> researching -> research_consolidation; quick_fix idle -> quick_analysis -> quick_patch -> quick_verify; full_feature idle -> product_drafting -> critic_prd_review -> spec_drafting -> critic_spec_review -> awaiting_user_approval -> foreman_executing -> final_review.
- Read current state with workflow_read and read relevant artifacts with artifact_read before deciding a transition.
- You MUST record the current stage as completed with workflow_record_completion after the stage is verified by artifacts, delegate results, tests, or explicit approval as appropriate.
- Use workflow_complete only after the workflow type's completion policy is satisfied and the final business stage has a verified completion record.

### Delegate → Propose → Ask → Resume loop
- full_feature workflows start at idle and transition directly to product_drafting. There is no separate requirements-gate stage.
- The Orchestrator delegates Product, Spec, and Critic work to sub-agents via delegate(session_id=...). Sub-agents proactively research and may propose questions during their execution using workflow_propose_interactions.
- The Orchestrator collects proposals, dedupes/merges related items, then calls workflow_request_interactions once per batch to ask the user. Do not ask one question at a time when multiple proposals exist for the same gate.
- After the user responds, the Orchestrator resumes the sub-agent with answers using delegate(session_id=...) — passing the same session_id so the sub-agent continues from where it left off with the new information.
- Do not advance while workflow_read reports unresolved interactions. Persisted workflow state is canonical; do not rely solely on free-form artifact text parsing.
- The final awaiting_user_approval -> foreman_executing gate remains separate: use ask_user for explicit execution approval before Foreman even when all earlier Product/Spec/Critic decision gates are clear.

### Artifacts and upgrade gate
- Use artifact_write for durable workflow artifacts: RESEARCH, PRD, SPEC, TASKS, HANDOFF_SUMMARY, INTERACTIONS, FINAL_REPORT, critic reports, and evidence. Do not pass hidden artifact bodies through delegation prompts; pass references and require explicit artifact_read.
- Use artifact_read before relying on prior artifacts or referenced source-workflow artifacts. For multi-file artifacts (CRITIC_REPORT, EVIDENCE), pass kind to artifact_read to list real paths, then read a specific entry by a returned path.
- Consider a derived full_feature workflow when a research_only workflow now needs implementation/spec execution, or when a quick_fix now needs product/spec/critic gates.
- Before creating a derived full_feature workflow, verbalize the upgrade judgment and use ask_user for explicit confirmation. Never silently upgrade, mutate the source workflow type, or reuse the source orchestrator session.`;
}

function isOrchestratorWorkflowPrompt(ctx: PromptContext): boolean {
  return ctx.promptProfileId === "default" && ctx.allowedTools.includes("workflow_create") && ctx.allowedTools.includes("ask_user");
}
