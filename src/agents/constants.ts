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
  "todo_write",
] as const;

export const DELEGATION_TOOLS = ["delegate", "wait_for_reminder", "background_output"] as const;