// ─── Builtin Tool Name Constants ───

// File I/O
export const TOOL_FILE_READ = "file_read";
export const TOOL_FILE_WRITE = "file_write";
export const TOOL_FILE_EDIT = "file_edit";

// Search
export const TOOL_GREP = "grep";
export const TOOL_GLOB = "glob";

// AST Grep
export const TOOL_AST_GREP_SEARCH = "ast_grep_search";
export const TOOL_AST_GREP_REPLACE = "ast_grep_replace";

// Git
export const TOOL_GIT_STATUS = "git_status";
export const TOOL_GIT_DIFF = "git_diff";

// Shell
export const TOOL_BASH = "bash";

// Interaction
export const TOOL_TODO_WRITE = "todo_write";
export const TOOL_ASK_USER = "ask_user";

// LSP
export const TOOL_LSP_DIAGNOSTICS = "lsp_diagnostics";
export const TOOL_LSP_GOTO_DEFINITION = "lsp_goto_definition";
export const TOOL_LSP_FIND_REFERENCES = "lsp_find_references";
export const TOOL_LSP_SYMBOLS = "lsp_symbols";

// Web
export const TOOL_WEB_FETCH = "web_fetch";

// Delegation
export const TOOL_DELEGATE = "delegate";
export const TOOL_WAIT_FOR_REMINDER = "wait_for_reminder";
export const TOOL_BACKGROUND_OUTPUT = "background_output";
export const TOOL_VIEW_TOOL_OUTPUT = "view_tool_output";
export const TOOL_CANCEL_SESSION = "cancel_session";

// Skills
export const TOOL_SKILL_LIST = "skill_list";
export const TOOL_SKILL_READ = "skill_read";

// Memory
export const TOOL_MEMORY_READ = "memory_read";
export const TOOL_MEMORY_WRITE = "memory_write";

// Workflow
export const TOOL_WORKFLOW_CREATE = "workflow_create";
export const TOOL_WORKFLOW_READ = "workflow_read";
export const TOOL_WORKFLOW_UPDATE_STAGE = "workflow_update_stage";
export const TOOL_WORKFLOW_PROPOSE_INTERACTIONS = "workflow_propose_interactions";
export const TOOL_WORKFLOW_REQUEST_INTERACTIONS = "workflow_request_interactions";
export const TOOL_WORKFLOW_TASK_CHECK = "workflow_task_check";

// Artifacts
export const TOOL_ARTIFACT_READ = "artifact_read";
export const TOOL_ARTIFACT_WRITE = "artifact_write";

// Goal (replaces Workflow in Phase 2 cutover)
export const TOOL_GOAL_CREATE = "goal_create";
export const TOOL_GOAL_LOCK = "goal_lock";
export const TOOL_GOAL_RUN = "goal_run";
export const TOOL_GOAL_RETRY = "goal_retry";
export const TOOL_GOAL_CHECK_DONE = "goal_check_done";

// ─── BuiltinToolName Union (derived from constants) ───
export type BuiltinToolName =
  | typeof TOOL_FILE_READ
  | typeof TOOL_FILE_WRITE
  | typeof TOOL_FILE_EDIT
  | typeof TOOL_GREP
  | typeof TOOL_GLOB
  | typeof TOOL_AST_GREP_SEARCH
  | typeof TOOL_AST_GREP_REPLACE
  | typeof TOOL_GIT_STATUS
  | typeof TOOL_GIT_DIFF
  | typeof TOOL_BASH
  | typeof TOOL_TODO_WRITE
  | typeof TOOL_ASK_USER
  | typeof TOOL_LSP_DIAGNOSTICS
  | typeof TOOL_LSP_GOTO_DEFINITION
  | typeof TOOL_LSP_FIND_REFERENCES
  | typeof TOOL_LSP_SYMBOLS
  | typeof TOOL_WEB_FETCH
  | typeof TOOL_DELEGATE
  | typeof TOOL_WAIT_FOR_REMINDER
  | typeof TOOL_BACKGROUND_OUTPUT
  | typeof TOOL_VIEW_TOOL_OUTPUT
  | typeof TOOL_CANCEL_SESSION
  | typeof TOOL_SKILL_LIST
  | typeof TOOL_SKILL_READ
  | typeof TOOL_MEMORY_READ
  | typeof TOOL_MEMORY_WRITE
  | typeof TOOL_WORKFLOW_CREATE
  | typeof TOOL_WORKFLOW_READ
  | typeof TOOL_WORKFLOW_UPDATE_STAGE
  | typeof TOOL_WORKFLOW_PROPOSE_INTERACTIONS
  | typeof TOOL_WORKFLOW_REQUEST_INTERACTIONS
  | typeof TOOL_WORKFLOW_TASK_CHECK
  | typeof TOOL_ARTIFACT_READ
  | typeof TOOL_ARTIFACT_WRITE
  | typeof TOOL_GOAL_CREATE
  | typeof TOOL_GOAL_LOCK
  | typeof TOOL_GOAL_RUN
  | typeof TOOL_GOAL_RETRY
  | typeof TOOL_GOAL_CHECK_DONE;

// ─── Tool Category (cross-package semantic classification) ───
export type ToolCategory =
  | "fileRead"
  | "fileWrite"
  | "search"
  | "git"
  | "shell"
  | "interaction"
  | "lsp"
  | "web"
  | "delegation"
  | "skill"
  | "memory"
  | "workflow"
  | "goal"
  | "mcp"
  | "other";

// ─── Category Map (exhaustive — covers every BuiltinToolName) ───
export const TOOL_CATEGORY_MAP = {
  [TOOL_FILE_READ]: "fileRead",
  [TOOL_FILE_WRITE]: "fileWrite",
  [TOOL_FILE_EDIT]: "fileWrite",
  [TOOL_GREP]: "search",
  [TOOL_GLOB]: "search",
  [TOOL_AST_GREP_SEARCH]: "search",
  [TOOL_AST_GREP_REPLACE]: "fileWrite",
  [TOOL_GIT_STATUS]: "git",
  [TOOL_GIT_DIFF]: "git",
  [TOOL_BASH]: "shell",
  [TOOL_TODO_WRITE]: "interaction",
  [TOOL_ASK_USER]: "interaction",
  [TOOL_LSP_DIAGNOSTICS]: "lsp",
  [TOOL_LSP_GOTO_DEFINITION]: "lsp",
  [TOOL_LSP_FIND_REFERENCES]: "lsp",
  [TOOL_LSP_SYMBOLS]: "lsp",
  [TOOL_WEB_FETCH]: "web",
  [TOOL_DELEGATE]: "delegation",
  [TOOL_WAIT_FOR_REMINDER]: "delegation",
  [TOOL_BACKGROUND_OUTPUT]: "delegation",
  [TOOL_VIEW_TOOL_OUTPUT]: "delegation",
  [TOOL_CANCEL_SESSION]: "delegation",
  [TOOL_SKILL_LIST]: "skill",
  [TOOL_SKILL_READ]: "skill",
  [TOOL_MEMORY_READ]: "memory",
  [TOOL_MEMORY_WRITE]: "memory",
  [TOOL_WORKFLOW_CREATE]: "workflow",
  [TOOL_WORKFLOW_READ]: "workflow",
  [TOOL_WORKFLOW_UPDATE_STAGE]: "workflow",
  [TOOL_WORKFLOW_PROPOSE_INTERACTIONS]: "workflow",
  [TOOL_WORKFLOW_REQUEST_INTERACTIONS]: "workflow",
  [TOOL_WORKFLOW_TASK_CHECK]: "workflow",
  [TOOL_ARTIFACT_READ]: "fileRead",
  [TOOL_ARTIFACT_WRITE]: "fileWrite",
  [TOOL_GOAL_CREATE]: "goal",
  [TOOL_GOAL_LOCK]: "goal",
  [TOOL_GOAL_RUN]: "goal",
  [TOOL_GOAL_RETRY]: "goal",
  [TOOL_GOAL_CHECK_DONE]: "goal",
} as const satisfies Record<BuiltinToolName, ToolCategory>;

// ─── Helpers ───

/**
 * Returns the semantic category for a tool name.
 *
 * - Builtin names resolve via the exhaustive `TOOL_CATEGORY_MAP`.
 * - Names starting with `mcp__` are categorised as `"mcp"`.
 * - Unknown or empty names fall back to `"other"`.
 */
export function getToolCategory(toolName: string | undefined): ToolCategory {
  if (!toolName) return "other";
  if (toolName.startsWith("mcp__")) return "mcp";
  return (TOOL_CATEGORY_MAP as Record<string, ToolCategory | undefined>)[toolName] ?? "other";
}

/**
 * Type guard that narrows a string to `BuiltinToolName` if it matches
 * one of the known builtin constants.
 */
export function isBuiltinToolName(name: string): name is BuiltinToolName {
  return name in TOOL_CATEGORY_MAP;
}
