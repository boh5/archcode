export { orchestratorAgentDefinition } from "./orchestrator";
export { planAgentDefinition } from "./plan";
export { buildAgentDefinition } from "./build";
export { reviewerAgentDefinition } from "./reviewer";
export { exploreAgentDefinition } from "./explore";
export { librarianAgentDefinition } from "./librarian";

import { orchestratorAgentDefinition } from "./orchestrator";
import { planAgentDefinition } from "./plan";
import { buildAgentDefinition } from "./build";
import { reviewerAgentDefinition } from "./reviewer";
import { exploreAgentDefinition } from "./explore";
import { librarianAgentDefinition } from "./librarian";
import type { AgentDefinition } from "../factory-types";

export const agentDefinitions = [
  orchestratorAgentDefinition,
  planAgentDefinition,
  buildAgentDefinition,
  reviewerAgentDefinition,
  exploreAgentDefinition,
  librarianAgentDefinition,
] as const satisfies readonly AgentDefinition[];

export const defaultAgentDefinitions = agentDefinitions;
