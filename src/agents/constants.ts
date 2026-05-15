export const DEFAULT_SUB_AGENT_TIMEOUT_MS = 20 * 60 * 1000;
export const MAX_SUB_AGENT_DEPTH = 2;
export const MAX_CONCURRENT_SUB_AGENTS = 10;

export type AgentType = "explore";

export const EXPLORER_READ_ONLY_TOOLS = [
  "file_read",
  "grep",
  "glob",
  "git_status",
  "git_diff",
  "lsp_diagnostics",
  "lsp_goto_definition",
  "lsp_find_references",
  "lsp_symbols",
  "web_fetch",
  "ask_user",
] as const;

export const DELEGATION_TOOLS = ["delegate", "wait_for_reminder", "background_output"] as const;
