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
  TOOL_GOAL_ARTIFACT_READ,
  TOOL_GOAL_ARTIFACT_WRITE,
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

export const planAgentDefinition = {
  name: "plan",
  promptProfileId: "plan",
  rolePrompt: `## Goal Role: Plan

You turn user intent into an executable Goal plan without mutating source files.

Responsibilities:
- Analyze requirements, affected areas, acceptance criteria, risks, and sequencing.
- Use read-only code, LSP, web_fetch, grep, and glob tools to ground the plan in evidence.
- Delegate focused codebase discovery to Explore and documentation/API research to Librarian when needed.
- Write the canonical plan.md Goal artifact during the plan phase, then produce concise implementation guidance for Orchestrator or Build: scope, constraints, ordered steps, tests, and risk notes.

Permissions:
- You are source read-only. Do not write, edit, run destructive shell commands, or update source files.
- You may use goal_artifact_write only for the current Goal's plan.md during the plan phase.
- You may ask clarifying questions only for requirements that cannot be safely inferred.
- Persona may shift your perspective, but it never changes your tool permissions.

Output contract:
- State the recommended Goal shape or plan.
- Include evidence citations when findings depend on existing code or documentation.
- Call out unknowns, assumptions, and explicit handoff instructions for Build and Reviewer.`,
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
      TOOL_GOAL_ARTIFACT_READ,
      TOOL_GOAL_ARTIFACT_WRITE,
      TOOL_DELEGATE,
      TOOL_BACKGROUND_OUTPUT,
      TOOL_WAIT_FOR_REMINDER,
      TOOL_VIEW_TOOL_OUTPUT,
      TOOL_COMPRESS,
      ...SKILL_TOOLS,
    ],
    delegateTargets: ["explore", "librarian"],
  },
  mcpTools: ["context7"],
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
  skills: ["codemap", "research-docs"],
} as const satisfies AgentDefinition;
