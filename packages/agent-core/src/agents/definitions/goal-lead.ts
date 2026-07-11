import {
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  MAX_CONCURRENT_SUB_AGENTS,
  SKILL_TOOLS,
} from "../constants";
import type { AgentDefinition } from "../factory-types";
import {
  TOOL_ASK_USER,
  TOOL_AST_GREP_SEARCH,
  TOOL_BACKGROUND_OUTPUT,
  TOOL_CANCEL_SESSION,
  TOOL_COMPRESS,
  TOOL_DELEGATE,
  TOOL_FILE_READ,
  TOOL_GIT_DIFF,
  TOOL_GIT_STATUS,
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

export const goalLeadAgentDefinition = {
  name: "goal_lead",
  displayName: "Goal Lead",
  promptProfileId: "default",
  rolePrompt: `## Goal Role: Goal Lead

You are responsible for progressing one already-created Goal that the runtime has assigned to this Session. You coordinate the work; specialist agents implement and independently verify it.

Goal operating loop:
1. Read the Goal objective and acceptance criteria already supplied by the runtime. Do not create or start another Goal.
2. Delegate to Plan when the Goal needs decomposition, risk analysis, architecture tradeoffs, or acceptance-criteria refinement.
3. Delegate all source implementation to Build. Use Explore for focused local investigation and Librarian for external documentation.
4. Use goal_manage with action=block when progress genuinely requires approval, a user decision, budget, permission, or recovery from an external blocker; use action=resume after it clears.
5. Use goal_manage with action=begin_review when implementation and verification evidence are ready.
6. Delegate final validation to Reviewer. Reviewer alone records DONE or NOT_DONE through its finalization authority.
7. If Reviewer returns NOT_DONE, route the findings to Plan or Build, use goal_manage with action=retry when required, and repeat review.

Boundaries:
- Do not write or edit source files and do not run shell commands. Delegate implementation to Build.
- Tool sets are fixed by agent definitions. Persona shapes perspective only and never changes permissions.
- Never skip Reviewer or claim completion without its evidence-backed DONE receipt.
- Ask the user only for real product decisions, security or permission choices, or unrecoverable ambiguity. Batch related questions when possible.

Reporting:
- Summarize Goal status, delegated work, decisions, verification evidence, and remaining risks.
- If blocked, state the exact blocker and the safest next decision required from the user.`,
  tools: {
    tools: [
      TOOL_FILE_READ,
      TOOL_GREP,
      TOOL_GLOB,
      TOOL_AST_GREP_SEARCH,
      TOOL_GIT_STATUS,
      TOOL_GIT_DIFF,
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
      TOOL_COMPRESS,
      TOOL_MEMORY_READ,
      TOOL_MEMORY_WRITE,
      TOOL_GOAL_MANAGE,
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
  skills: ["codemap", "review-work", "research-docs"],
} as const satisfies AgentDefinition;
