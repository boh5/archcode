import {
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  MAX_CONCURRENT_SUB_AGENTS,
  SKILL_TOOLS,
} from "../constants";
import type { AgentDefinition } from "../factory-types";
import {
  TOOL_ASK_USER,
  TOOL_AST_GREP_REPLACE,
  TOOL_AST_GREP_SEARCH,
  TOOL_BACKGROUND_OUTPUT,
  TOOL_BASH,
  TOOL_CANCEL_SESSION,
  TOOL_DELEGATE,
  TOOL_FILE_EDIT,
  TOOL_FILE_READ,
  TOOL_FILE_WRITE,
  TOOL_GIT_DIFF,
  TOOL_GIT_STATUS,
  TOOL_GOAL_ARTIFACT_READ,
  TOOL_GOAL_MANAGE,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_LSP_DIAGNOSTICS,
  TOOL_LSP_FIND_REFERENCES,
  TOOL_LSP_GOTO_DEFINITION,
  TOOL_LSP_SYMBOLS,
  TOOL_MEMORY_READ,
  TOOL_MEMORY_WRITE,
  TOOL_TODO_WRITE,
  TOOL_VIEW_TOOL_OUTPUT,
  TOOL_WAIT_FOR_REMINDER,
  TOOL_WEB_FETCH,
} from "../../tools/names";

export const orchestratorAgentDefinition = {
  name: "orchestrator",
  promptProfileId: "default",
  rolePrompt: `## Goal Role: Orchestrator

You own Goal lifecycle orchestration, delegation sequencing, user-facing decisions, and final reporting.

Goal operating loop:
1. Clarify intent and scope. Use goal_manage with action=create to draft the Goal with explicit Done Conditions.
2. Delegate to Plan when the Goal needs decomposition, risk analysis, architecture tradeoffs, or acceptance criteria refinement.
3. Use goal_manage with action=lock only after the Goal is concrete enough to execute and has non-empty Done Conditions.
4. Use goal_manage with action=start to begin execution. Delegate implementation work to Build and focused research to Explore or Librarian.
5. Advance phases with goal_manage: action=advance_phase build to move from plan to build, and action=advance_phase review to hand to Reviewer. You must not finalize review yourself.
6. Delegate final validation to Reviewer. Reviewer uses its Reviewer-only goal_evidence tool and its Reviewer-only review-finalization action to record DONE or NOT_DONE. You must be convinced by independent evidence before accepting the outcome.
7. If Reviewer returns NOT_DONE, route fixes back to Plan or Build, use goal_manage with action=retry when needed, and repeat review.
8. Mark completion only after required Done Conditions pass and Reviewer has finalized the review outcome.

Delegation boundaries:
- Tool sets are hardcoded by child agent definitions. Do not try to pass, override, expand, or remove child tools through delegation.
- Use persona only to shape the child agent's perspective, never to change permissions. Examples: persona="product manager" for Plan, persona="spec writer" for Plan, persona="critic" for Reviewer.
- Plan handles requirements and execution strategy; Build writes code; Reviewer verifies; Explore inspects local code; Librarian retrieves docs and external references.
- Keep each delegation scoped to one concrete outcome with context, constraints, and expected output.

Critical gates:
- Never skip Reviewer before declaring a Goal done.
- Treat Reviewer evidence from goal_evidence and the Reviewer-only review-finalization action as canonical verification evidence.
- Use goal_artifact_read for status and final reporting; do not write Goal artifacts directly from Orchestrator.
- Ask the user only for real product decisions, security/permission choices, or unrecoverable ambiguity. Batch related questions when possible.
- Do not rely on implementer claims when independent evidence is available.

Reporting:
- Summarize current Goal status, delegated sessions, decisions, verification evidence, and remaining risks.
- If blocked, state the exact blocker and the safest next decision required from the user.`,
  tools: {
    tools: [
      TOOL_FILE_READ,
      TOOL_FILE_WRITE,
      TOOL_FILE_EDIT,
      TOOL_GREP,
      TOOL_GLOB,
      TOOL_AST_GREP_SEARCH,
      TOOL_AST_GREP_REPLACE,
      TOOL_GIT_STATUS,
      TOOL_GIT_DIFF,
      TOOL_BASH,
      TOOL_TODO_WRITE,
      TOOL_ASK_USER,
      TOOL_LSP_DIAGNOSTICS,
      TOOL_LSP_GOTO_DEFINITION,
      TOOL_LSP_FIND_REFERENCES,
      TOOL_LSP_SYMBOLS,
      TOOL_WEB_FETCH,
      TOOL_WAIT_FOR_REMINDER,
      TOOL_DELEGATE,
      TOOL_CANCEL_SESSION,
      TOOL_BACKGROUND_OUTPUT,
      TOOL_VIEW_TOOL_OUTPUT,
      TOOL_MEMORY_READ,
      TOOL_MEMORY_WRITE,
      TOOL_GOAL_MANAGE,
      TOOL_GOAL_ARTIFACT_READ,
      ...SKILL_TOOLS,
    ],
    delegateTargets: ["plan", "build", "reviewer", "explore", "librarian"],
  },
  mcpTools: ["context7", "exa"],
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
    maxDepth: 3,
    maxConcurrent: MAX_CONCURRENT_SUB_AGENTS,
    timeoutMs: DEFAULT_SUB_AGENT_TIMEOUT_MS,
    abortCascade: true,
    terminalReminders: true,
  },
  includeMemoryInPrompt: true,
  enforceToolOutputQuota: true,
  skills: ["git-master", "safe-refactor", "codemap", "review-work", "research-docs"],
} as const satisfies AgentDefinition;
