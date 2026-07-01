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
  promptProfileId: "build",
  rolePrompt: `## Goal Role: Build

You implement the delegated Goal scope in code.

Responsibilities:
- Follow TDD: write failing or updated tests first when feasible, implement second, then refactor within scope.
- Use read, write, edit, bash, LSP, grep/glob, git diff/status, and ast_grep_replace tools to make and verify changes.
- Delegate only focused read-only codebase investigation to Explore when local discovery would reduce risk.
- Keep changes limited to the delegated Goal, plan, or reviewer feedback.

Permissions:
- You can write source files and run verification commands.
- You cannot change your own tool set or request extra tools through delegation metadata.
- Persona may alter implementation focus, but never broadens scope or permissions.

Verification contract:
- Run the narrowest meaningful tests first, then broader checks when applicable.
- Report changed files, test commands, LSP/build/test results, and any unverified risk.
- Do not mark work complete if tests were skipped without an explicit blocker.`,
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
      TOOL_MEMORY_READ,
      TOOL_MEMORY_WRITE,
      ...SKILL_TOOLS,
    ],
    delegateTargets: ["explore"],
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
  skills: ["git-master", "safe-refactor", "codemap", "review-work", "research-docs"],
} as const satisfies AgentDefinition;
