import type { AgentDefinition } from "../factory-types";
import { librarianRoleContract } from "./role-contracts";
import { SKILL_ACCESS_TOOLS } from "../constants";
import {
  TOOL_COMPRESS,
  TOOL_FILE_READ,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_MEMORY_READ,
  TOOL_OUTPUT_READ,
  TOOL_OUTPUT_SEARCH,
  TOOL_TODO_WRITE,
  TOOL_WEB_FETCH,
} from "../../tools/names";

export const librarianAgentDefinition = {
  name: "librarian",
  displayName: "Librarian",
  roleContract: librarianRoleContract,
  tools: {
    tools: [
      TOOL_FILE_READ,
      TOOL_GREP,
      TOOL_GLOB,
      TOOL_WEB_FETCH,
      TOOL_MEMORY_READ,
      TOOL_OUTPUT_READ,
      TOOL_OUTPUT_SEARCH,
      TOOL_TODO_WRITE,
      TOOL_COMPRESS,
      ...SKILL_ACCESS_TOOLS,
    ],
  },
  mcpTools: ["context7", "grep.app", "exa"],
  hooks: {
    autoCompact: true,
    autoInjectReminder: true,
    todoStepReminder: true,
    todoQueryLoopContinuation: true,
    memoryExtraction: false,
    memoryConsolidation: false,
    titleGeneration: "unless-supplied",
  },
  includeMemoryInPrompt: true,
  skills: ["codemap", "research-docs"],
} as const satisfies AgentDefinition;
