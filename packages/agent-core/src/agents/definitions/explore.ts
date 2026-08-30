import type { AgentDefinition } from "../factory-types";
import { defineAgentDefinition } from "../tool-filter";
import { exploreRoleContract } from "./role-contracts";
import { SKILL_ACCESS_TOOLS } from "../constants";
import { TOOL_TOOL_SEARCH } from "@archcode/protocol";
import {
  TOOL_AST_GREP_SEARCH,
  TOOL_COMPRESS,
  TOOL_FILE_READ,
  TOOL_PDF_READ,
  TOOL_GIT_DIFF,
  TOOL_GIT_STATUS,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_LSP_DIAGNOSTICS,
  TOOL_LSP_FIND_REFERENCES,
  TOOL_LSP_GOTO_DEFINITION,
  TOOL_LSP_SYMBOLS,
  TOOL_OUTPUT_READ,
  TOOL_OUTPUT_SEARCH,
  TOOL_TODO_WRITE,
} from "../../tools/names";

export const exploreAgentDefinition = defineAgentDefinition({
  name: "explore",
  displayName: "Explore",
  builtinMcpServers: [],
  profiles: ["fast"],
  roleContract: exploreRoleContract,
  tools: {
    authorized: [
      TOOL_FILE_READ,
      TOOL_PDF_READ,
      TOOL_GREP,
      TOOL_GLOB,
      TOOL_GIT_STATUS,
      TOOL_GIT_DIFF,
      TOOL_AST_GREP_SEARCH,
      TOOL_LSP_DIAGNOSTICS,
      TOOL_LSP_GOTO_DEFINITION,
      TOOL_LSP_FIND_REFERENCES,
      TOOL_LSP_SYMBOLS,
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
      TOOL_GIT_STATUS,
      TOOL_GIT_DIFF,
      TOOL_TODO_WRITE,
      ...SKILL_ACCESS_TOOLS,
    ],
  },
  hooks: {
    autoCompact: true,
    autoInjectReminder: true,
    todoStepReminder: true,
    todoQueryLoopContinuation: true,
    titleGeneration: "unless-supplied",
  },
  includeMemoryInPrompt: false,
  skills: ["codemap"],
} as const satisfies AgentDefinition);
