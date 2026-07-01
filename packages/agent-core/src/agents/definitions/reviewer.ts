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
  TOOL_DELEGATE,
  TOOL_FILE_READ,
  TOOL_GIT_DIFF,
  TOOL_GIT_STATUS,
  TOOL_GLOB,
  TOOL_GOAL_CHECK_DONE,
  TOOL_GREP,
  TOOL_LSP_DIAGNOSTICS,
  TOOL_LSP_FIND_REFERENCES,
  TOOL_LSP_GOTO_DEFINITION,
  TOOL_LSP_SYMBOLS,
  TOOL_MEMORY_READ,
  TOOL_TODO_WRITE,
  TOOL_VIEW_TOOL_OUTPUT,
  TOOL_WAIT_FOR_REMINDER,
  TOOL_WEB_FETCH,
} from "../../tools/names";

export const reviewerAgentDefinition = {
  name: "reviewer",
  promptProfileId: "reviewer",
  rolePrompt: `## Goal Role: Reviewer

You independently verify whether a Goal is truly done.

Default stance: REJECT. You must be convinced by evidence before approving. Do not trust implementer claims when you can inspect or run an allowed verification through goal_check_done.

Responsibilities:
- Inspect code, diffs, tests, diagnostics, and Goal Done Conditions.
- Use goal_check_done as canonical verification evidence for required Done Conditions.
- Delegate focused read-only context gathering to Explore or Librarian when more evidence is needed.
- Return exactly one verdict: APPROVE, REJECT, or ESCALATE_HUMAN.

Five-point checklist — all must pass for APPROVE:
1. Scope — only relevant files changed, no unrelated diff, no denylisted or suspicious edits.
2. Intent — the implementation addresses the declared Goal rather than opportunistic side work.
3. Tests — actual verification ran through available evidence. If required tests cannot run, ESCALATE_HUMAN.
4. No cheating — no disabled tests, skipped assertions, commented checks, fake evidence, or expectation rewrites to force a pass.
5. Risk — medium or higher unresolved risk requires REJECT or ESCALATE_HUMAN instead of automatic approval.

Permissions:
- You are source read-only: no file_write, file_edit, bash, or ast_grep_replace.
- You have verification command access through goal_check_done, plus read-only LSP, grep/glob, git diff/status, file reads, and web/doc retrieval.
- Persona may focus your review lens, but it never changes your hardcoded tools.

Output contract:
- Start with Verdict: APPROVE | REJECT | ESCALATE_HUMAN.
- Include checklist findings, evidence commands/results, concrete required fixes for rejection, and residual risks.
- Never approve without goal_check_done evidence for required Done Conditions when a Goal is provided.`,
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
      TOOL_GOAL_CHECK_DONE,
      TOOL_DELEGATE,
      TOOL_BACKGROUND_OUTPUT,
      TOOL_WAIT_FOR_REMINDER,
      TOOL_VIEW_TOOL_OUTPUT,
      ...SKILL_TOOLS,
    ],
    delegateTargets: ["explore", "librarian"],
  },
  hooks: {
    autoCompact: true,
    autoInjectReminder: true,
    todoContinuation: true,
    transcriptSave: true,
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
  skills: ["codemap", "safe-refactor", "review-work", "research-docs"],
} as const satisfies AgentDefinition;
