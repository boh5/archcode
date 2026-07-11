import {
  EXPLORER_READ_ONLY_TOOLS,
  DELEGATION_TOOLS,
  SKILL_TOOLS,
} from "../tools/groups";
import type { AgentName } from "./names";

export {
  EXPLORER_READ_ONLY_TOOLS,
  DELEGATION_TOOLS,
  SKILL_TOOLS,
};

export const DEFAULT_SUB_AGENT_TIMEOUT_MS = 20 * 60 * 1000;
export const MAX_SUB_AGENT_DEPTH = 3;
export const MAX_CONCURRENT_SUB_AGENTS = 10;

export type AgentType = AgentName;
