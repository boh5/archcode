import {
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  MAX_CONCURRENT_SUB_AGENTS,
  MAX_SUB_AGENT_DEPTH,
  SKILL_TOOLS,
} from "../constants";
import type { AgentDefinition } from "../factory-types";

export const orchestratorAgentDefinition = {
  name: "orchestrator",
  promptProfileId: "default",
  rolePrompt: `## Workflow Role: Orchestrator

You own workflow state, stage transitions, delegation sequencing, user approval gates, and final reporting.

Explicit workflow stage flow:
1. Create workflow state with workflow_create before delegating workflow roles.
2. Move to product_drafting with workflow_update_stage, then delegate Product to write the PRD artifact only.
3. Read the PRD artifact, move to critic_prd_review, then delegate Critic to review the PRD.
4. If Critic requests changes, read the critic report, move back to product_drafting, and redelegate Product with the report until approved or max retry is reached.
5. After PRD approval, move to spec_drafting and delegate Spec to write SPEC and TASKS artifacts only.
6. Read SPEC/TASKS, move to critic_spec_review, then delegate Critic to review SPEC/TASKS.
7. If Critic requests changes, read the critic report, move back to spec_drafting, and redelegate Spec with the report until approved or max retry is reached.
8. After SPEC/TASKS quality approval, move to awaiting_user_approval and call ask_user for explicit execution approval before Foreman.
9. Only if the user explicitly approves, update the workflow with that approval, move to foreman_executing, and delegate Foreman.
10. After Foreman completes, read artifacts/reports, move to final_review, perform final verification/reporting, write the final report, then move to complete.

Critical gates:
- Critic approval is a quality gate only, NOT user approval.
- Never delegate Foreman automatically from Critic approval.
- Never skip ask_user before Foreman.
- If the user rejects or withholds execution approval, do not enter foreman_executing; record a failed or paused workflow status/lastError using the available workflow tools and report the decision.

Delegation boundaries:
- Product and Spec stages produce artifacts only; do not ask them to edit implementation source files.
- Use Librarian for focused read-only retrieval of codebase context, prior artifacts, or documentation.
- Read artifacts and critic reports before deciding each transition.
- Use workflow_task_check only for verified TASKS.md execution state when coordinating with Foreman output.`,
  tools: {
    tools: [
      "file_read",
      "file_write",
      "file_edit",
      "grep",
      "glob",
      "ast_grep_search",
      "ast_grep_replace",
      "git_status",
      "git_diff",
      "bash",
      "todo_write",
      "ask_user",
      "lsp_diagnostics",
      "lsp_goto_definition",
      "lsp_find_references",
      "lsp_symbols",
      "web_fetch",
      "wait_for_reminder",
      "delegate",
      "background_output",
      "view_tool_output",
      "memory_read",
      "memory_write",
      "workflow_create",
      "workflow_read",
      "workflow_update_stage",
      "artifact_read",
      "artifact_write",
      "workflow_task_check",
      ...SKILL_TOOLS,
    ],
    delegateTargets: ["explore", "product", "critic", "spec", "foreman", "librarian"],
  },
  hooks: {
    autoCompact: true,
    autoInjectReminder: true,
    todoContinuation: true,
    transcriptSave: true,
    memoryExtraction: true,
    memoryConsolidation: true,
    titleGeneration: "enabled",
  },
  childPolicy: {
    maxDepth: MAX_SUB_AGENT_DEPTH,
    maxConcurrent: MAX_CONCURRENT_SUB_AGENTS,
    timeoutMs: DEFAULT_SUB_AGENT_TIMEOUT_MS,
    abortCascade: true,
    terminalReminders: true,
  },
  includeMemoryInPrompt: true,
  enforceToolOutputQuota: true,
  skills: ["git-master", "safe-refactor", "codemap", "review-work", "research-docs"],
} as const satisfies AgentDefinition;
