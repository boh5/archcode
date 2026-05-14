import type { AgentDefinition } from "../factory-types";

export const exploreAgentDefinition = {
  name: "explore",
  promptAgentId: "explorer",
  tools: {
    tools: [
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
    ],
  },
  hooks: {
    autoCompact: true,
    autoInjectReminder: true,
    todoContinuation: true,
    transcriptSave: true,
    memoryExtraction: true,
    memoryConsolidation: true,
    titleGeneration: "unless-supplied",
  },
  includeMemoryInPrompt: true,
} as const satisfies AgentDefinition;
