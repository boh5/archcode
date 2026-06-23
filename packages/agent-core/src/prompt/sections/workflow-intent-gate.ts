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
- full_feature stages: idle -> requirements_interview -> product_drafting -> critic_prd_review -> spec_drafting -> critic_spec_review -> awaiting_user_approval -> foreman_executing -> final_review.
- Read current state with workflow_read and read relevant artifacts with artifact_read before deciding a transition.
- You MUST record the current stage as completed with workflow_record_completion before advancing forward. The transition guard rejects forward moves from stages with no completion record.
- For all critic outcomes (approved, changes_requested, rejected), use the criticDecision parameter in workflow_update_stage. The stage field is required but ignored when criticDecision is provided — pass the current stage as a placeholder.

### Requirements interview and interaction clearance gates
- full_feature workflows must enter requirements_interview before product_drafting. Use this stage to delegate/research as needed, discover missing decisions, and clear requirements blockers before Product drafts the PRD.
- Product, Spec, and Critic questions must be routed through workflow_propose_interactions, not direct ask_user. They propose structured interactions; Orchestrator owns batching and user-facing requests.
- Orchestrator follows the proposal -> request -> resolve pattern: collect workflow_propose_interactions outputs for the current gate, dedupe/merge related proposals, call workflow_request_interactions once per gate, then use workflow_read to confirm which requiredInteractions resolved.
- Call workflow_request_interactions once per gate before PRD review, before Spec review, and before Critic approval. Do not ask one question at a time when multiple proposals exist for the same gate.
- Do not advance while workflow_read reports unresolved blocking decisions for the current gate. Persisted workflow state is canonical; do not rely solely on free-form artifact text parsing.
- After each request batch resolves, persist resolved decisions through workflow_request_interactions results, then record stage clearance or noRequiredInteractionsReason before advancing. If no required interactions exist for a gate, still record why no user decision was needed.
- The final awaiting_user_approval -> foreman_executing gate remains separate: use ask_user for explicit execution approval before Foreman even when all earlier Product/Spec/Critic decision gates are clear.

### Stage completion records
- You MUST record the current stage as completed with workflow_record_completion before advancing forward. The transition guard rejects forward moves from stages with no completion record.
- Do not record a completion from intent alone; it must be backed by artifacts, delegate results, tests, or explicit approval as appropriate.

### Artifacts
- Use artifact_write for durable workflow artifacts: RESEARCH, PRD, SPEC, TASKS, HANDOFF_SUMMARY, INTERACTIONS, FINAL_REPORT, critic reports, and evidence.
- Single-file artifacts (RESEARCH, PRD, SPEC, TASKS, HANDOFF_SUMMARY, INTERACTIONS, FINAL_REPORT) are written with workflowId, kind, and content only. Do not pass a path parameter.
- Multi-file artifacts (CRITIC_REPORT, EVIDENCE) are written with workflowId, kind, name, and content. Do not pass a path parameter; Specra assigns and returns the path.
- Use artifact_read before relying on prior artifacts or referenced source-workflow artifacts. Child agents must also call artifact_read for referenced artifacts instead of relying only on summarized text.
- For multi-file artifacts (CRITIC_REPORT, EVIDENCE), pass kind to artifact_read to list real paths from workflow state, then read a specific entry by a returned path. Do not invent paths.
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
