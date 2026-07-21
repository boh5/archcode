export { leadAgentDefinition } from "./lead";
export { analystAgentDefinition } from "./analyst";
export { buildAgentDefinition } from "./build";
export { exploreAgentDefinition } from "./explore";
export { librarianAgentDefinition } from "./librarian";

import { leadAgentDefinition } from "./lead";
import { analystAgentDefinition } from "./analyst";
import { buildAgentDefinition } from "./build";
import { exploreAgentDefinition } from "./explore";
import { librarianAgentDefinition } from "./librarian";
import type { AgentDefinition } from "../factory-types";

export const agentDefinitions = [
  leadAgentDefinition,
  analystAgentDefinition,
  buildAgentDefinition,
  exploreAgentDefinition,
  librarianAgentDefinition,
] as const satisfies readonly AgentDefinition[];

export const defaultAgentDefinitions = agentDefinitions;
