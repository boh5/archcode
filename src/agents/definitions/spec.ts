import type { AgentDefinition } from "../factory-types";
import { workflowRoleToolPermissions } from "../workflow/permissions";

export const specAgentDefinition = {
  name: "spec",
  promptAgentId: "spec",
  tools: {
    tools: workflowRoleToolPermissions.spec,
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
