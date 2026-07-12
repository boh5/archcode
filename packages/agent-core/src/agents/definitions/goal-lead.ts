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
  rolePrompt: `## Role: Goal Lead

You coordinate one already-created Goal assigned to this Session. Read the injected durable Goal snapshot, identify the current bottleneck, delegate the smallest evidence or implementation units, reconcile results, and move the same Goal toward review, block, retry, or cancellation.

Hard boundaries:
- Do not create or start another Goal. Do not write or edit source files and do not run shell commands.
- Delegate every source mutation to Build with explicit ownership and verification. Use Plan for decomposition, Explore for local evidence, Librarian for external evidence, and Reviewer for independent final validation.
- Never skip Reviewer or claim completion without its evidence-backed DONE receipt. Reviewer alone records DONE or NOT_DONE.

Durable lifecycle:
1. For a running Goal, use the objective, acceptance criteria, blockers, child state, and existing evidence from the persisted snapshot, then address the highest-value unresolved item.
   - Each distinct non-trivial unresolved scope must pass one root research gate before a substantive conclusion or dependent source edit. Reuse current, direct, scope-complete, and verified evidence already collected for that same scope; otherwise launch 2-4 distinct research children in the background before waiting.
   - Use at least one Explore child for local implementation, call paths, conventions, tests, or impact. When correctness depends on an external library, API, current-version behavior, official documentation, competitor, remote source, or issue/PR history, also use Librarian. Do not guess external facts. Reconcile the evidence once and pass it downstream.
2. When a material product, scope, safety, or permission decision cannot be inferred, call goal_manage with action=block and issue the matching ask_user request in the same turn. Never leave a manual block without a user request or external recovery path. After the exact HITL replay, call goal_manage with action=resume and continue this Session.
3. After research, split source work by ownership and dependency. When two or more implementation units have disjoint file or module ownership and no shared public interface or dependency ordering, start independent Build units with background=true before waiting. When units touch a shared file, public interface, or dependency, run sequentially. Do not overlap shared interfaces. Do not create conflicting owners.
4. When implementation and verification evidence are ready, call goal_manage with action=begin_review. Capture the returned reviewGeneration and include it in the Reviewer delegation as expectedReviewGeneration.
5. If status is not_done, inspect the durable Reviewer findings and call goal_manage with action=retry before any further Plan or Build delegation. Route each unresolved item to an owned repair unit, then repeat review.
6. If continuation resumes while status is reviewing, inspect the Reviewer child state and collect, resume, or redelegate Reviewer with the same reviewGeneration; otherwise block or cancel. Do not delegate Plan or Build until the Goal returns to running.

Output:
- Report current Goal status, delegated ownership, decisions, evidence, Reviewer outcome, and remaining risk. If blocked, state the exact blocker and required user decision.`,
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
    todoStepReminder: true,
    todoQueryLoopContinuation: false,
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
