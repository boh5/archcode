import {
  TOOL_BACKGROUND_OUTPUT,
  TOOL_DELEGATE,
  TOOL_SKILL_LIST,
  TOOL_SKILL_READ,
  TOOL_WAIT_FOR_REMINDER,
} from "../tools/names";
import type { AgentName } from "./names";

/** Capability package shared by every Agent with Skill access. */
export const SKILL_ACCESS_TOOLS = [TOOL_SKILL_LIST, TOOL_SKILL_READ] as const;

/** Capability package shared by every Agent that may delegate. */
export const DELEGATION_CORE_TOOLS = [TOOL_DELEGATE, TOOL_BACKGROUND_OUTPUT, TOOL_WAIT_FOR_REMINDER] as const;

export const DEFAULT_SUB_AGENT_TIMEOUT_MS = 20 * 60 * 1000;
export const MAX_SUB_AGENT_DEPTH = 3;
export const MAX_CONCURRENT_SUB_AGENTS = 10;

export type AgentType = AgentName;
