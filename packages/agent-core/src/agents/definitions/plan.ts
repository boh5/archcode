import {
  DELEGATION_CORE_TOOLS,
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  MAX_CONCURRENT_SUB_AGENTS,
  SKILL_ACCESS_TOOLS,
} from "../constants";
import type { AgentDefinition } from "../factory-types";
import {
  TOOL_ASK_USER,
  TOOL_AST_GREP_SEARCH,
  TOOL_COMPRESS,
  TOOL_FILE_READ,
  TOOL_GIT_DIFF,
  TOOL_GIT_STATUS,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_LSP_DIAGNOSTICS,
  TOOL_LSP_FIND_REFERENCES,
  TOOL_LSP_GOTO_DEFINITION,
  TOOL_LSP_SYMBOLS,
  TOOL_MEMORY_READ,
  TOOL_TODO_WRITE,
  TOOL_VIEW_TOOL_OUTPUT,
  TOOL_WEB_FETCH,
} from "../../tools/names";

export const planAgentDefinition = {
  name: "plan",
  displayName: "Plan",
  promptProfileId: "plan",
  rolePrompt: `## Role: Plan

You convert delegated engineering intent into one evidence-backed implementation plan. You are source read-only: do not write or edit source files, mutate Git state, or invent Goal ceremony when no explicit Goal contract is present.

Planning loop:
1. Identify the requested outcome, acceptance criteria, scope, non-goals, and decisions that would materially change the approach.
2. Apply the Delegation Policy to fill missing local evidence with Explore and missing external evidence with Librarian. Read the critical files they identify and reconcile conflicts.
3. Compare viable approaches internally, then recommend one. Do not return an unresolved menu of alternatives.
4. Define file ownership, dependency order, safe overlap, tests, and Reviewer evidence before handing off.
5. Ask only for a material decision that evidence cannot resolve; batch related questions and continue this Session after the answer.

Output contract:
- Recommendation
- Evidence
- Scope and non-goals
- Ordered file-level steps
- Verification
- Risks and unresolved decisions
- Build and Reviewer handoff`,
  tools: {
    tools: [
      TOOL_FILE_READ,
      TOOL_GREP,
      TOOL_GLOB,
      TOOL_GIT_STATUS,
      TOOL_GIT_DIFF,
      TOOL_AST_GREP_SEARCH,
      TOOL_LSP_DIAGNOSTICS,
      TOOL_LSP_GOTO_DEFINITION,
      TOOL_LSP_FIND_REFERENCES,
      TOOL_LSP_SYMBOLS,
      TOOL_WEB_FETCH,
      TOOL_ASK_USER,
      TOOL_MEMORY_READ,
      TOOL_TODO_WRITE,
      ...DELEGATION_CORE_TOOLS,
      TOOL_VIEW_TOOL_OUTPUT,
      TOOL_COMPRESS,
      ...SKILL_ACCESS_TOOLS,
    ],
    delegateTargets: ["explore", "librarian"],
  },
  mcpTools: ["context7"],
  hooks: {
    autoCompact: true,
    autoInjectReminder: true,
    todoStepReminder: true,
    todoQueryLoopContinuation: true,
    memoryExtraction: false,
    memoryConsolidation: false,
    titleGeneration: "unless-supplied",
  },
  childPolicy: {
    maxDepth: 2,
    maxConcurrent: MAX_CONCURRENT_SUB_AGENTS,
    timeoutMs: DEFAULT_SUB_AGENT_TIMEOUT_MS,
    abortCascade: true,
    terminalReminders: true,
  },
  includeMemoryInPrompt: true,
  enforceToolOutputQuota: true,
  skills: ["codemap", "research-docs"],
} as const satisfies AgentDefinition;
