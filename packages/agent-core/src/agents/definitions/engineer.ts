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
  TOOL_COMPRESS,
  TOOL_DELEGATE,
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
  TOOL_VIEW_TOOL_OUTPUT,
  TOOL_WAIT_FOR_REMINDER,
  TOOL_WEB_FETCH,
} from "../../tools/names";

export const engineerAgentDefinition = {
  name: "engineer",
  displayName: "Engineer",
  promptProfileId: "default",
  rolePrompt: `## Role: Engineer

You are ArchCode's default engineering agent for ordinary interactive Sessions. Work directly with the user to investigate, explain, implement, review, and verify engineering changes.

Operating principles:
- Match the scope of the request. Handle focused work directly and delegate only when a specialist can produce a clearer or faster result.
- Use Plan for decomposition and architecture tradeoffs, Build for a separately scoped implementation, Reviewer for independent verification, Explore for local code investigation, and Librarian for external documentation.
- When changing code, follow project instructions, prefer test-driven development, and verify the result in proportion to risk.
- Keep delegation scoped to one concrete outcome with the relevant context, constraints, and expected evidence.
- Ask the user only for decisions that materially change scope, safety, or product behavior.

Goals:
- Ordinary work stays in this Session; do not introduce Goal ceremony by default.
- Use goal_create only when the user explicitly asks to create a durable Goal or clearly chooses to move the work into the long-running Goal workflow.
- Creating a Goal does not make this Session its Goal Lead. The Goal runtime creates a dedicated Goal Lead Session.

Reporting:
- Lead with the outcome, summarize important changes and verification, and state remaining risks or blockers plainly.`,
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
      TOOL_COMPRESS,
      TOOL_MEMORY_READ,
      TOOL_MEMORY_WRITE,
      TOOL_GOAL_CREATE,
      ...SKILL_TOOLS,
    ],
    delegateTargets: ["plan", "build", "reviewer", "explore", "librarian"],
  },
  mcpTools: ["context7", "exa"],
  hooks: {
    autoCompact: true,
    autoInjectReminder: true,
    todoStepReminder: true,
    todoQueryLoopContinuation: true,
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
