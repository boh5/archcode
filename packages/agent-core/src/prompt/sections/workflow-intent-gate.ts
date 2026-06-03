import type { PromptContext } from "../types";

export function buildWorkflowIntentGateSection(ctx: PromptContext): string | null {
  if (!isOrchestratorWorkflowPrompt(ctx)) return null;

  return `## Workflow MVP Orchestration

### Workflow type selection
- Use workflow_create when the user asks for async/long-running work, explicit workflow coordination, artifact-driven planning, implementation with gates, or work that needs durable stage/status tracking.
- Choose research_only for investigation or answer synthesis that should produce RESEARCH without source edits.
- Choose quick_fix for narrow, low-risk fixes that can go directly through quick_analysis -> quick_patch -> quick_verify without PRD/SPEC/Critic gates.
- Choose full_feature for new features, broad refactors, ambiguous requirements, multi-file execution, user approval gates, or anything that needs PRD, SPEC, TASKS, Critic, and Foreman execution.

### Stage progression
- Use workflow_update_stage for every business-stage move. Never invent terminal stages; completion and failure are lifecycle status, not stage names.
- research_only stages: idle -> researching -> research_consolidation.
- quick_fix stages: idle -> quick_analysis -> quick_patch -> quick_verify.
- full_feature stages: idle -> product_drafting -> critic_prd_review -> spec_drafting -> critic_spec_review -> awaiting_user_approval -> foreman_executing -> final_review.
- Read current state with workflow_read and read relevant artifacts with artifact_read before deciding a transition.

### Stage completion records
- Use workflow_record_completion when a stage's required work has actually been verified, including critic approvals, research consolidation, quick verification, and final review.
- Record completions before moving into downstream gated stages when the graph requires prior-stage evidence.
- Do not record a completion from intent alone; it must be backed by artifacts, delegate results, tests, or explicit approval as appropriate.

### Artifacts
- Use artifact_write for durable workflow artifacts: RESEARCH, PRD, SPEC, TASKS, HANDOFF_SUMMARY, INTERACTIONS, FINAL_REPORT, critic reports, evidence, and notes.
- Use artifact_read before relying on prior artifacts or referenced source-workflow artifacts. Child agents must also call artifact_read for referenced artifacts instead of relying only on summarized text.
- Do not pass hidden artifact bodies through delegation prompts; pass references and require explicit artifact_read.

### Completion
- Use workflow_complete only after the workflow type's completion policy is satisfied and the final business stage has a verified completion record.
- Completing a workflow sets status=completed while preserving the last business stage, such as research_consolidation, quick_verify, or final_review.

### Intent Gate: Workflow Upgrades
- Consider a derived full_feature workflow when a research_only workflow now needs implementation/spec execution, or when a quick_fix now needs product/spec/critic gates.
- Before upgrading, verbalize the upgrade judgment, then use ask_user for explicit confirmation. Never silently upgrade, mutate the source workflow type, or reuse the source orchestrator session.
- After confirmation, create a derived workflow by calling workflow_create with the target type (e.g., full_feature). The system will create the derived workflow with a derivedFrom link to the source, generate a handoff summary, and start a fresh Orchestrator session.
- Put the handoff summary plus artifact_read references for source artifacts in the derived session's first user message so the new orchestrator can read prior context before delegation.
- Batch related blockers and upgrade questions together; avoid serial one-question interruptions when the decisions belong to the same gate.`;
}

function isOrchestratorWorkflowPrompt(ctx: PromptContext): boolean {
  return ctx.promptProfileId === "default" && ctx.allowedTools.includes("workflow_create") && ctx.allowedTools.includes("ask_user");
}
