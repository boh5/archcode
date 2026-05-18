import type { AgentDefinition } from "../factory-types";
import { workflowRoleToolPermissions } from "../workflow/permissions";

export const reviewerAgentDefinition = {
  name: "reviewer",
  promptAgentId: "reviewer",
  tools: {
    tools: workflowRoleToolPermissions.reviewer,
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
  enforceToolOutputQuota: true,
} as const satisfies AgentDefinition;
