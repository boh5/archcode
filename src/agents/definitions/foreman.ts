import {
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  MAX_CONCURRENT_SUB_AGENTS,
  MAX_SUB_AGENT_DEPTH,
} from "../constants";
import type { AgentDefinition } from "../factory-types";
import { workflowRoleToolPermissions } from "../workflow/permissions";

export const foremanAgentDefinition = {
  name: "foreman",
  promptAgentId: "foreman",
  tools: {
    tools: workflowRoleToolPermissions.foreman,
    delegateTargets: ["builder", "reviewer"],
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
  childPolicy: {
    maxDepth: MAX_SUB_AGENT_DEPTH,
    maxConcurrent: MAX_CONCURRENT_SUB_AGENTS,
    timeoutMs: DEFAULT_SUB_AGENT_TIMEOUT_MS,
    abortCascade: true,
    terminalReminders: true,
  },
  includeMemoryInPrompt: true,
  enforceToolOutputQuota: true,
} as const satisfies AgentDefinition;
