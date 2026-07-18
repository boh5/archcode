import type { AgentDefinition } from "../factory-types";
import { exploreRoleContract } from "./role-contracts";
import { SKILL_ACCESS_TOOLS } from "../constants";
import {
  TOOL_AST_GREP_SEARCH,
  TOOL_COMPRESS,
  TOOL_FILE_READ,
  TOOL_GIT_DIFF,
  TOOL_GIT_STATUS,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_LSP_DIAGNOSTICS,
  TOOL_LSP_FIND_REFERENCES,
  TOOL_LSP_GOTO_DEFINITION,
  TOOL_LSP_SYMBOLS,
  TOOL_TODO_WRITE,
} from "../../tools/names";

export const exploreAgentDefinition = {
  name: "explore",
  displayName: "Explore",
  roleContract: exploreRoleContract,
  tools: {
    tools: [
      TOOL_FILE_READ,
      TOOL_GREP,
      TOOL_GLOB,
      TOOL_GIT_STATUS,
      TOOL_GIT_DIFF,
      TOOL_AST_GREP_SEARCH,
      TOOL_LSP_DIAGNOSTICS,
      TOOL_LSP_GOTO_DEFINITION,
      TOOL_LSP_FIND_REFERENCES,
      TOOL_LSP_SYMBOLS,
      TOOL_TODO_WRITE,
      TOOL_COMPRESS,
      ...SKILL_ACCESS_TOOLS,
      "submit_child_result",
    ],
  },
  hooks: {
    autoCompact: true,
    autoInjectReminder: true,
    todoStepReminder: true,
    todoQueryLoopContinuation: true,
    memoryExtraction: false,
    memoryConsolidation: false,
    titleGeneration: "unless-supplied",
  },
  includeMemoryInPrompt: false,
  skills: ["codemap"],
} as const satisfies AgentDefinition;
