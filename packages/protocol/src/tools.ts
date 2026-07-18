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

// Session worktree transitions (dynamically exposed to interactive root sessions)
export const TOOL_WORKTREE_ENTER = "worktree_enter";
export const TOOL_WORKTREE_EXIT = "worktree_exit";

// Generic GitHub connectors; registered globally but not default agent tools.
export const TOOL_GITHUB_GET_PULL_REQUEST = "github_get_pull_request";
export const TOOL_GITHUB_LIST_PULL_REQUESTS = "github_list_pull_requests";
export const TOOL_GITHUB_GET_PULL_REQUEST_CHECKS = "github_get_pull_request_checks";
export const TOOL_GITHUB_LIST_ISSUE_COMMENTS = "github_list_issue_comments";
export const TOOL_GITHUB_CREATE_ISSUE_COMMENT = "github_create_issue_comment";
export const TOOL_GITHUB_LIST_WORKFLOW_RUNS = "github_list_workflow_runs";
export const TOOL_GITHUB_GET_WORKFLOW_RUN = "github_get_workflow_run";
export const TOOL_GITHUB_RERUN_WORKFLOW_RUN = "github_rerun_workflow_run";

// Shell
export const TOOL_BASH = "bash";

// Interaction
export const TOOL_TODO_WRITE = "todo_write";
export const TOOL_PROJECT_TODO_UPDATE = "project_todo_update";
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
export const TOOL_RESUME_SESSION = "resume_session";
export const TOOL_WAIT_FOR_REMINDER = "wait_for_reminder";
export const TOOL_BACKGROUND_OUTPUT = "background_output";
export const TOOL_SUBMIT_CHILD_RESULT = "submit_child_result";
export const TOOL_VIEW_TOOL_OUTPUT = "view_tool_output";
export const TOOL_CANCEL_SESSION = "cancel_session";

// Skills
export const TOOL_SKILL_LIST = "skill_list";
export const TOOL_SKILL_READ = "skill_read";

// Memory
export const TOOL_MEMORY_READ = "memory_read";
export const TOOL_MEMORY_WRITE = "memory_write";

// Goal lifecycle tools
export const TOOL_GOAL_CREATE = "goal_create";
export const TOOL_GOAL_MANAGE = "goal_manage";
export const TOOL_AUTOMATION_CREATE = "automation_create";

// Compression
export const TOOL_COMPRESS = "compress";

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
  | typeof TOOL_WORKTREE_ENTER
  | typeof TOOL_WORKTREE_EXIT
  | typeof TOOL_GITHUB_GET_PULL_REQUEST
  | typeof TOOL_GITHUB_LIST_PULL_REQUESTS
  | typeof TOOL_GITHUB_GET_PULL_REQUEST_CHECKS
  | typeof TOOL_GITHUB_LIST_ISSUE_COMMENTS
  | typeof TOOL_GITHUB_CREATE_ISSUE_COMMENT
  | typeof TOOL_GITHUB_LIST_WORKFLOW_RUNS
  | typeof TOOL_GITHUB_GET_WORKFLOW_RUN
  | typeof TOOL_GITHUB_RERUN_WORKFLOW_RUN
  | typeof TOOL_BASH
  | typeof TOOL_TODO_WRITE
  | typeof TOOL_PROJECT_TODO_UPDATE
  | typeof TOOL_ASK_USER
  | typeof TOOL_LSP_DIAGNOSTICS
  | typeof TOOL_LSP_GOTO_DEFINITION
  | typeof TOOL_LSP_FIND_REFERENCES
  | typeof TOOL_LSP_SYMBOLS
  | typeof TOOL_WEB_FETCH
  | typeof TOOL_DELEGATE
  | typeof TOOL_RESUME_SESSION
  | typeof TOOL_WAIT_FOR_REMINDER
  | typeof TOOL_BACKGROUND_OUTPUT
  | typeof TOOL_SUBMIT_CHILD_RESULT
  | typeof TOOL_VIEW_TOOL_OUTPUT
  | typeof TOOL_CANCEL_SESSION
  | typeof TOOL_SKILL_LIST
  | typeof TOOL_SKILL_READ
  | typeof TOOL_MEMORY_READ
  | typeof TOOL_MEMORY_WRITE
  | typeof TOOL_GOAL_CREATE
  | typeof TOOL_GOAL_MANAGE
  | typeof TOOL_AUTOMATION_CREATE
  | typeof TOOL_COMPRESS;

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
  | "goal"
  | "automation"
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
  [TOOL_WORKTREE_ENTER]: "git",
  [TOOL_WORKTREE_EXIT]: "git",
  [TOOL_GITHUB_GET_PULL_REQUEST]: "git",
  [TOOL_GITHUB_LIST_PULL_REQUESTS]: "git",
  [TOOL_GITHUB_GET_PULL_REQUEST_CHECKS]: "git",
  [TOOL_GITHUB_LIST_ISSUE_COMMENTS]: "git",
  [TOOL_GITHUB_CREATE_ISSUE_COMMENT]: "git",
  [TOOL_GITHUB_LIST_WORKFLOW_RUNS]: "git",
  [TOOL_GITHUB_GET_WORKFLOW_RUN]: "git",
  [TOOL_GITHUB_RERUN_WORKFLOW_RUN]: "git",
  [TOOL_BASH]: "shell",
  [TOOL_TODO_WRITE]: "interaction",
  [TOOL_PROJECT_TODO_UPDATE]: "interaction",
  [TOOL_ASK_USER]: "interaction",
  [TOOL_LSP_DIAGNOSTICS]: "lsp",
  [TOOL_LSP_GOTO_DEFINITION]: "lsp",
  [TOOL_LSP_FIND_REFERENCES]: "lsp",
  [TOOL_LSP_SYMBOLS]: "lsp",
  [TOOL_WEB_FETCH]: "web",
  [TOOL_DELEGATE]: "delegation",
  [TOOL_RESUME_SESSION]: "delegation",
  [TOOL_WAIT_FOR_REMINDER]: "delegation",
  [TOOL_BACKGROUND_OUTPUT]: "delegation",
  [TOOL_SUBMIT_CHILD_RESULT]: "delegation",
  [TOOL_VIEW_TOOL_OUTPUT]: "delegation",
  [TOOL_CANCEL_SESSION]: "delegation",
  [TOOL_SKILL_LIST]: "skill",
  [TOOL_SKILL_READ]: "skill",
  [TOOL_MEMORY_READ]: "memory",
  [TOOL_MEMORY_WRITE]: "memory",
  [TOOL_GOAL_CREATE]: "goal",
  [TOOL_GOAL_MANAGE]: "goal",
  [TOOL_AUTOMATION_CREATE]: "automation",
  [TOOL_COMPRESS]: "other",
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
