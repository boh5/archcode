// ─── Tool Groups (single source of truth) ───
// All groups reference constants from names.ts

import {
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
  TOOL_DELEGATE,
  TOOL_WAIT_FOR_REMINDER,
  TOOL_BACKGROUND_OUTPUT,
  TOOL_VIEW_TOOL_OUTPUT,
  TOOL_SKILL_LIST,
  TOOL_SKILL_READ,
  TOOL_ARTIFACT_READ,
} from "./names";

/**
 * Tools available to the Explorer (depth 0/1) sub-agent.
 * These are all read-only tools (except explorer also gets todo_write explicitly in explore.ts).
 */
export const EXPLORER_READ_ONLY_TOOLS = [
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
  TOOL_ARTIFACT_READ,
] as const;

/**
 * Tools used for delegation between agents.
 */
export const DELEGATION_TOOLS = [
  TOOL_DELEGATE,
  TOOL_WAIT_FOR_REMINDER,
  TOOL_BACKGROUND_OUTPUT,
] as const;

/**
 * Tools used for skill loading and reading.
 */
export const SKILL_TOOLS = [
  TOOL_SKILL_LIST,
  TOOL_SKILL_READ,
] as const;

/**
 * Tools used for workflow delegation execution (includes view_tool_output).
 */
export const DELEGATION_EXECUTION_TOOLS = [
  TOOL_DELEGATE,
  TOOL_BACKGROUND_OUTPUT,
  TOOL_WAIT_FOR_REMINDER,
  TOOL_VIEW_TOOL_OUTPUT,
] as const;
