import type { AgentDefinition } from "../factory-types";
import { defineAgentDefinition } from "../tool-filter";
import { librarianRoleContract } from "./role-contracts";
import { SKILL_ACCESS_TOOLS } from "../constants";
import { TOOL_TOOL_SEARCH } from "@archcode/protocol";
import {
  TOOL_COMPRESS,
  TOOL_FILE_READ,
  TOOL_PDF_READ,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_MEMORY_READ,
  TOOL_OUTPUT_READ,
  TOOL_OUTPUT_SEARCH,
  TOOL_TODO_WRITE,
  TOOL_WEB_FETCH,
} from "../../tools/names";

export const librarianAgentDefinition = defineAgentDefinition({
  name: "librarian",
  displayName: "Librarian",
  profiles: ["fast"],
  roleContract: librarianRoleContract,
  tools: {
    authorized: [
      TOOL_FILE_READ,
      TOOL_PDF_READ,
      TOOL_GREP,
      TOOL_GLOB,
      TOOL_WEB_FETCH,
      TOOL_MEMORY_READ,
      TOOL_OUTPUT_READ,
      TOOL_OUTPUT_SEARCH,
      TOOL_TODO_WRITE,
      TOOL_COMPRESS,
      ...SKILL_ACCESS_TOOLS,
      TOOL_TOOL_SEARCH,
    ],
    core: [
      TOOL_FILE_READ,
      TOOL_GREP,
      TOOL_GLOB,
      TOOL_WEB_FETCH,
      TOOL_MEMORY_READ,
      TOOL_TODO_WRITE,
      ...SKILL_ACCESS_TOOLS,
    ],
  },
  builtinMcpServers: ["context7", "grep.app", "exa"],
  hooks: {
    autoCompact: true,
    autoInjectReminder: true,
    todoStepReminder: true,
    todoQueryLoopContinuation: true,
    titleGeneration: "unless-supplied",
  },
  includeMemoryInPrompt: true,
  skills: ["codemap", "research-docs"],
} as const satisfies AgentDefinition);
