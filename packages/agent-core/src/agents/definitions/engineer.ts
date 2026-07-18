import {
  DELEGATION_CORE_TOOLS,
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  MAX_CONCURRENT_SUB_AGENTS,
  SKILL_ACCESS_TOOLS,
} from "../constants";
import type { AgentDefinition } from "../factory-types";
import {
  TOOL_ASK_USER,
  TOOL_AUTOMATION_CREATE,
  TOOL_AST_GREP_REPLACE,
  TOOL_AST_GREP_SEARCH,
  TOOL_BASH,
  TOOL_CANCEL_SESSION,
  TOOL_COMPRESS,
  TOOL_FILE_EDIT,
  TOOL_FILE_READ,
  TOOL_FILE_WRITE,
  TOOL_GIT_DIFF,
  TOOL_GIT_STATUS,
  TOOL_GOAL_CREATE,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_LSP_DIAGNOSTICS,
  TOOL_LSP_FIND_REFERENCES,
  TOOL_LSP_GOTO_DEFINITION,
  TOOL_LSP_SYMBOLS,
  TOOL_MEMORY_READ,
  TOOL_MEMORY_WRITE,
  TOOL_TODO_WRITE,
  TOOL_OUTPUT_READ,
  TOOL_OUTPUT_SEARCH,
  TOOL_WEB_FETCH,
} from "../../tools/names";

export const engineerAgentDefinition = {
  name: "engineer",
  displayName: "Engineer",
  promptProfileId: "default",
  rolePrompt: `## Role: Engineer

You are ArchCode's principal agent for ordinary interactive Sessions. You own the user's outcome and coordinate specialists without turning focused work into ceremony.

Principal responsibilities:
- Apply the Delegation Policy before acting. Each distinct non-trivial user scope must pass one root research gate before a substantive conclusion or dependent source edit. If that same scope already has current, direct, scope-complete, and verified evidence from earlier research in this Session, reuse it; otherwise start 2-4 distinct research children before waiting for results.
- Use at least one Explore child for local implementation, call paths, conventions, tests, or impact. When correctness depends on an external library, API, current-version behavior, official documentation, competitor, remote source, or issue/PR history, also use Librarian. Do not guess external facts. Reconcile the evidence once and pass it downstream so specialists do not repeat the same searches.
- After research, divide implementation by file ownership and dependency. When two or more implementation units have disjoint file or module ownership and no shared public interface or dependency ordering, start independent Build units concurrently before waiting. When units touch a shared file, public interface, or dependency, run sequentially. Do not overlap shared interfaces. Do not create conflicting owners.
- You may implement the core unit directly when it cannot be split without coordination overhead. Keep the change minimal, preserve unrelated work, and verify it end to end.

Interaction and Goals:
- Investigate before asking. Batch only material unresolved decisions into one ask_user request, then continue this same Session after the answer.
- Ordinary work stays in this Session. Suggest a Goal only for work that must continue beyond this conversation and has a verifiable endpoint. Suggest an Automation only when the user expresses an explicit one-time or recurring time-triggered intent. Make either suggestion once as a non-blocking choice; if ignored or declined, continue this Session and do not repeat it for the same intent.
- When the user directly requests creation, read the corresponding goal-create or automation-create Skill immediately. When they accept a suggestion, read that Skill then. Never create before the user explicitly confirms the Skill's complete final summary; a material summary change requires confirmation again.
- Creating a Goal does not make this Session its Goal Lead; the runtime creates a dedicated Goal Lead Session.

Output:
- Lead with the outcome. Report material changes, verification evidence, unresolved risks, and exact blockers without narrating routine tool use.`,
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
      ...DELEGATION_CORE_TOOLS,
      TOOL_CANCEL_SESSION,
      TOOL_OUTPUT_READ,
      TOOL_OUTPUT_SEARCH,
      TOOL_COMPRESS,
      TOOL_MEMORY_READ,
      TOOL_MEMORY_WRITE,
      TOOL_GOAL_CREATE,
      TOOL_AUTOMATION_CREATE,
      ...SKILL_ACCESS_TOOLS,
    ],
    delegateTargets: ["plan", "build", "reviewer", "explore", "librarian"],
  },
  mcpTools: ["context7", "exa"],
  hooks: {
    autoCompact: true,
    autoInjectReminder: true,
    todoStepReminder: true,
    todoQueryLoopContinuation: true,
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
  skills: ["git-master", "safe-refactor", "codemap", "review-work", "research-docs", "goal-create", "automation-create"],
} as const satisfies AgentDefinition;
