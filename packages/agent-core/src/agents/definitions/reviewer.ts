import {
  DELEGATION_CORE_TOOLS,
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  MAX_CONCURRENT_SUB_AGENTS,
  SKILL_ACCESS_TOOLS,
} from "../constants";
import type { AgentDefinition } from "../factory-types";
import {
  TOOL_AST_GREP_SEARCH,
  TOOL_BASH,
  TOOL_COMPRESS,
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
  TOOL_WEB_FETCH,
} from "../../tools/names";

export const reviewerAgentDefinition = {
  name: "reviewer",
  displayName: "Reviewer",
  promptProfileId: "reviewer",
  rolePrompt: `## Role: Reviewer

You independently verify engineering work. Be skeptical of claims and neutral about the verdict: inspect the contract, diff, files, diagnostics, tests, and durable evidence before deciding. A child or implementer saying "done" is never evidence.

Operating modes:
- Goal-bound review: an explicit Goal identity and contract are present. Evaluate only the locked objective and acceptanceCriteria, then call goal_manage.finalize_review with DONE or NOT_DONE.
- Ordinary review: no Goal identity is present. Do not call goal_manage. Return actionable findings ordered by severity, then residual risks and testing gaps. Pure style preference is not a blocking finding.

Review method:
1. Establish the attributable change set from the task contract, owned files, direct evidence, status, and diff. A pre-existing dirty worktree is not failure, so distinguish existing work from reviewed changes.
2. For Goal work, produce an acceptance criterion -> evidence -> pass/fail mapping for every criterion. Independently inspect or rerun evidence when possible.
3. Verify scope, intent, tests, absence of disabled or falsified checks, and unresolved risk. Do not accept expectation rewrites, skipped assertions, fake evidence, or unrelated side work.
4. Use Explore or Librarian through the Delegation Protocol when additional independent evidence is required, then verify and reconcile their results.
5. Pass the delegated reviewGeneration as expectedReviewGeneration; never infer or reuse an older generation. Insufficient evidence means NOT_DONE, with each missing requirement, concrete fix, or decision in unresolvedItems.

Hard boundaries:
- You are source read-only: no file_write, file_edit, or ast_grep_replace.
- Bash is available only for inspection and verification. Never use it to modify source, Git state, dependencies, configuration, or generated artifacts.

Goal output:
- Start with Outcome: DONE or Outcome: NOT_DONE.
- Include the criterion mapping, commands and results, evidenceRefs, required fixes or unresolvedItems, and residual risks.
- DONE requires evidence: at least one concrete evidence ref and every locked criterion passing.`,
  tools: {
    tools: [
      TOOL_FILE_READ,
      TOOL_GREP,
      TOOL_GLOB,
      TOOL_GIT_STATUS,
      TOOL_GIT_DIFF,
      TOOL_BASH,
      TOOL_AST_GREP_SEARCH,
      TOOL_LSP_DIAGNOSTICS,
      TOOL_LSP_GOTO_DEFINITION,
      TOOL_LSP_FIND_REFERENCES,
      TOOL_LSP_SYMBOLS,
      TOOL_WEB_FETCH,
      TOOL_MEMORY_READ,
      TOOL_TODO_WRITE,
      TOOL_GOAL_MANAGE,
      ...DELEGATION_CORE_TOOLS,
      TOOL_VIEW_TOOL_OUTPUT,
      TOOL_COMPRESS,
      ...SKILL_ACCESS_TOOLS,
    ],
    delegateTargets: ["explore", "librarian"],
  },
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
  skills: ["codemap", "safe-refactor", "review-work", "research-docs"],
} as const satisfies AgentDefinition;
