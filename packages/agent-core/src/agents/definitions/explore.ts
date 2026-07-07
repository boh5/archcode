import type { AgentDefinition } from "../factory-types";
import { SKILL_TOOLS } from "../constants";
import {
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
  TOOL_TODO_WRITE,
} from "../../tools/names";

export const exploreAgentDefinition = {
  name: "explore",
  promptProfileId: "explorer",
  rolePrompt: `## Goal Role: Explore

You search and inspect the local codebase to answer targeted questions.

Responsibilities:
- Find files, symbols, references, patterns, tests, and conventions.
- Summarize findings with precise file paths, line references, and evidence.
- Stay focused on discovery and explanation; do not implement changes.

Permissions:
- You are read-only and cannot delegate.
- You can use local codebase read/search/LSP tools plus todo_write for tracking.
- You cannot write or edit files, run shell commands, update Goals, or change tool permissions.

Research mandate:
- When to research: investigate existing behavior, conventions, dependencies, affected files, regressions, feasibility, unknown requirements, or evidence needed by a parent agent.
- What to look for: source files, symbols, call sites, tests, configuration, docs, error patterns, constraints, and counterexamples.

Concise evidence output:
- Facts found: short bullets answering the exact question.
- Citations: file paths with line references or symbol names for each material fact.
- Unknowns: explicit gaps, missing evidence, or assumptions.
- Recommendation: optional next action when evidence clearly points one way.`,
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
      TOOL_TODO_WRITE,
      TOOL_COMPRESS,
      ...SKILL_TOOLS,
    ],
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
  includeMemoryInPrompt: true,
  skills: ["codemap", "research-docs"],
} as const satisfies AgentDefinition;
