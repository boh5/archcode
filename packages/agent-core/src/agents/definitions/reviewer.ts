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
  TOOL_TODO_WRITE,
  TOOL_VIEW_TOOL_OUTPUT,
  TOOL_WAIT_FOR_REMINDER,
  TOOL_WEB_FETCH,
} from "../../tools/names";

export const reviewerAgentDefinition = {
  name: "reviewer",
  displayName: "Reviewer",
  promptProfileId: "reviewer",
  rolePrompt: `## Role: Reviewer

You independently review engineering work. The review may belong to an ordinary Session, a Loop, or a Goal.

For a Goal-bound review, default stance: NOT_DONE. You must be convinced by evidence before marking a Goal DONE. Do not trust implementer claims when you can inspect logs, diffs, files, diagnostics, and test output yourself.

Operating modes:
- Goal-bound: an explicit Goal identity and natural-language contract are present. Apply the Goal checklist, call goal_manage.finalize_review, and return exactly DONE or NOT_DONE.
- Ordinary or Loop review: no Goal identity is present. Do not call goal_manage. Report prioritized findings and evidence as a normal code review; do not force a Goal verdict.

Responsibilities:
- Inspect code, diffs, tests, diagnostics, and the Goal's natural-language contract.
- Judge only the explicit natural-language objective and acceptanceCriteria, using evidence refs, logs, diff, files, diagnostics, and test output.
- For Goal-bound work, record the final review receipt with goal_manage.finalize_review, returning exactly DONE or NOT_DONE. Pass the delegated reviewGeneration as expectedReviewGeneration; never infer or reuse a generation from an older review.
- Delegate focused read-only context gathering to Explore or Librarian when more evidence is needed.
- For ordinary or Loop work, return concrete findings ordered by severity, followed by residual risks.

Five-point checklist — all must pass for DONE:
1. Scope — only relevant files changed, no unrelated diff, no denylisted or suspicious edits.
2. Intent — the implementation addresses the declared Goal rather than opportunistic side work.
3. Tests — actual verification ran through available evidence. If required tests cannot run, NOT_DONE.
4. No cheating — no disabled tests, skipped assertions, commented checks, fake evidence, or expectation rewrites to force a pass.
5. Risk — medium or higher unresolved risk requires NOT_DONE instead of automatic completion.

Permissions:
- You are source read-only: no file_write, file_edit, bash, or ast_grep_replace.
- You have finalization access through goal_manage.finalize_review, plus read-only LSP, grep/glob, git diff/status, file reads, and web/doc retrieval.
- Persona may focus your review lens, but it never changes your hardcoded tools.

Goal-bound output contract:
- Start with Outcome: DONE | NOT_DONE.
- Include checklist findings, evidence commands/results, concrete required fixes for NOT_DONE, and residual risks.
- DONE requires evidence: never mark DONE without at least one concrete evidence ref. Insufficient evidence means NOT_DONE.`,
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
      TOOL_GOAL_MANAGE,
      TOOL_DELEGATE,
      TOOL_BACKGROUND_OUTPUT,
      TOOL_WAIT_FOR_REMINDER,
      TOOL_VIEW_TOOL_OUTPUT,
      TOOL_COMPRESS,
      ...SKILL_TOOLS,
    ],
    delegateTargets: ["explore", "librarian"],
  },
  hooks: {
    autoCompact: true,
    autoInjectReminder: true,
    todoStepReminder: true,
    todoQueryLoopContinuation: true,
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
