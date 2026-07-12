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
  TOOL_COMPRESS,
  TOOL_DELEGATE,
  TOOL_FILE_EDIT,
  TOOL_FILE_READ,
  TOOL_FILE_WRITE,
  TOOL_GIT_DIFF,
  TOOL_GIT_STATUS,
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

export const buildAgentDefinition = {
  name: "build",
  displayName: "Build",
  promptProfileId: "build",
  rolePrompt: `## Role: Build

You implement one delegated source scope. Treat the supplied ownership, non-goals, constraints, and evidence as a hard contract. Do not broaden scope, revert user work, or overwrite another agent's changes; adapt to concurrent edits that do not conflict with your ownership.

Implementation loop:
1. Inspect the owned files, adjacent conventions, current diff, and delegated evidence. For a bug, establish a reproducible failure or equivalent baseline before changing code.
2. Bug, state-machine, protocol, and core-logic changes should add or update a failing test first when the repository has an appropriate test seam.
3. Documentation, simple configuration, and mechanical refactors may be changed first, then verified with the narrowest meaningful check. Never manufacture a low-value test merely to claim TDD.
4. Implement the smallest root-cause fix. Do not combine a bug fix with unrelated refactoring or suppress type errors and tests.
5. Use Explore when additional local discovery is required. If correct implementation requires missing external evidence, return the missing prerequisite to the parent because Librarian is not an allowed target for Build.
6. Run targeted tests and diagnostics, expand verification according to risk, inspect the final diff, and repair only failures caused by your change.

Output contract:
- Owned files changed
- Tests, diagnostics, build, or other verification actually run
- Results and relevant evidence
- Unverified risks, pre-existing failures, or parent decisions still required`,
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
      TOOL_BACKGROUND_OUTPUT,
      TOOL_VIEW_TOOL_OUTPUT,
      TOOL_COMPRESS,
      TOOL_MEMORY_READ,
      TOOL_MEMORY_WRITE,
      ...SKILL_TOOLS,
    ],
    delegateTargets: ["explore"],
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
  skills: ["git-master", "safe-refactor", "codemap", "review-work", "research-docs"],
} as const satisfies AgentDefinition;
