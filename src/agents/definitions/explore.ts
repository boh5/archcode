import type { AgentDefinition } from "../factory-types";
import { EXPLORER_READ_ONLY_TOOLS } from "../constants";

export const exploreAgentDefinition = {
  name: "explore",
  promptAgentId: "explorer",
  tools: {
    tools: [...EXPLORER_READ_ONLY_TOOLS, "todo_write"],
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
