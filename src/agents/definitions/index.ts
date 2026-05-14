export { orchestratorAgentDefinition } from "./orchestrator";
export { exploreAgentDefinition } from "./explore";

import { orchestratorAgentDefinition } from "./orchestrator";
import { exploreAgentDefinition } from "./explore";

export const agentDefinitions = [orchestratorAgentDefinition, exploreAgentDefinition] as const satisfies readonly AgentDefinition[];
export const defaultAgentDefinitions = agentDefinitions;

import type { AgentDefinition } from "../factory-types";
