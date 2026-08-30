import type { AgentName } from "../names";

/**
 * Locked, no-state builtin corpus. This fixture deliberately does not import Agent
 * definitions so definition refactors cannot silently rewrite the search oracle.
 */
export const NO_STATE_DEFERRED_BUILTINS = {
  lead: [
    "pdf_read", "ast_grep_search", "ast_grep_replace", "lsp_diagnostics",
    "lsp_goto_definition", "lsp_find_references", "lsp_symbols", "web_fetch",
    "list_agents", "send_message", "background_output", "wait_for_reminder",
    "cancel_session", "resume_session", "output_read", "output_search", "compress",
    "memory_read", "memory_write", "create_goal", "get_goal", "update_goal",
    "automation_create",
  ],
  discussion: [
    "pdf_read", "ast_grep_search", "lsp_diagnostics", "lsp_goto_definition",
    "lsp_find_references", "lsp_symbols", "web_fetch", "memory_read", "memory_write",
    "project_todo_update", "list_agents", "send_message", "background_output",
    "wait_for_reminder", "cancel_session", "resume_session", "output_read",
    "output_search", "compress",
  ],
  analyst: [
    "pdf_read", "ast_grep_search", "lsp_diagnostics", "lsp_goto_definition",
    "lsp_find_references", "lsp_symbols", "web_fetch", "memory_read", "list_agents",
    "send_message", "background_output", "wait_for_reminder", "cancel_session",
    "resume_session", "output_read", "output_search", "compress",
  ],
  build: [
    "pdf_read", "ast_grep_search", "ast_grep_replace", "lsp_diagnostics",
    "lsp_goto_definition", "lsp_find_references", "lsp_symbols", "web_fetch",
    "list_agents", "send_message", "background_output", "wait_for_reminder",
    "cancel_session", "resume_session", "output_read", "output_search", "compress",
    "memory_read", "memory_write",
  ],
  explore: [
    "pdf_read", "ast_grep_search", "lsp_diagnostics", "lsp_goto_definition",
    "lsp_find_references", "lsp_symbols", "output_read", "output_search", "compress",
  ],
  librarian: ["pdf_read", "output_read", "output_search", "compress"],
} as const satisfies Record<AgentName, readonly string[]>;

export type ToolSearchEvalKind = "capability" | "synonym" | "typo";

export interface ToolSearchEvalCase {
  readonly agent: AgentName;
  readonly kind: ToolSearchEvalKind;
  readonly query: string;
  readonly namespace: "builtin";
  readonly expectedTool: string;
}

const TOOL_QUERIES = {
  pdf_read: ["extract text from an attached document", "inspect portable document pages"],
  ast_grep_search: ["find code by syntax tree structure", "structural source pattern lookup"],
  ast_grep_replace: ["rewrite code by syntax tree structure", "structural source transformation"],
  lsp_diagnostics: ["show compiler language errors", "inspect editor problem reports"],
  lsp_goto_definition: ["jump to where a symbol is declared", "locate declaration target"],
  lsp_find_references: ["locate every usage of a symbol", "locate symbol callers and usages"],
  lsp_symbols: ["list declarations in source files", "browse workspace symbol index"],
  web_fetch: ["download and read an internet page", "retrieve remote URL content"],
  list_agents: ["show descendant worker status", "inspect child task tree"],
  send_message: ["steer a running child worker", "communicate with a delegated task"],
  background_output: ["retrieve finished child task result", "collect delegated worker answer"],
  wait_for_reminder: ["pause until a child finishes", "pause until delegated task completion"],
  cancel_session: ["stop a descendant task", "abort a child worker"],
  resume_session: ["continue a stopped child task", "restart suspended delegated work"],
  output_read: ["inspect a captured command artifact", "page through stored execution result"],
  output_search: ["find text inside captured artifacts", "locate text inside stored command results"],
  compress: ["reduce conversation context size", "compact earlier model history"],
  memory_read: ["recall saved project knowledge", "look up persistent notes"],
  memory_write: ["save durable project knowledge", "record a persistent note"],
  create_goal: ["start a persistent objective protocol", "establish an ongoing objective"],
  get_goal: ["inspect current objective progress", "view ongoing objective status"],
  update_goal: ["mark current objective complete", "change ongoing objective status"],
  automation_create: ["schedule recurring autonomous work", "schedule a repeated background job"],
  project_todo_update: ["change the bound work item", "edit current backlog item"],
} as const satisfies Record<string, readonly [string, string]>;

export const TOOL_SEARCH_EVAL_CASES: readonly ToolSearchEvalCase[] = Object.entries(
  NO_STATE_DEFERRED_BUILTINS,
).flatMap(([agent, tools]) => tools.flatMap((expectedTool) => {
  const queries = TOOL_QUERIES[expectedTool as keyof typeof TOOL_QUERIES];
  if (queries === undefined) throw new Error(`Missing search queries for ${expectedTool}`);
  return [
    { agent: agent as AgentName, kind: "capability", query: queries[0], namespace: "builtin", expectedTool },
    { agent: agent as AgentName, kind: "synonym", query: queries[1], namespace: "builtin", expectedTool },
    { agent: agent as AgentName, kind: "typo", query: transposeLongestToken(expectedTool), namespace: "builtin", expectedTool },
  ] satisfies ToolSearchEvalCase[];
})) as readonly ToolSearchEvalCase[];

function transposeLongestToken(name: string): string {
  const parts = name.split("_");
  let longestIndex = 0;
  for (let index = 1; index < parts.length; index += 1) {
    if (parts[index]!.length > parts[longestIndex]!.length) longestIndex = index;
  }
  const token = parts[longestIndex]!;
  const pivot = Math.max(1, Math.floor(token.length / 2) - 1);
  parts[longestIndex] = token.slice(0, pivot) + token[pivot + 1] + token[pivot] + token.slice(pivot + 2);
  return parts.join("_");
}
