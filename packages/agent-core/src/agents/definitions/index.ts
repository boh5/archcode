export { engineerAgentDefinition } from "./engineer";
export { goalLeadAgentDefinition } from "./goal-lead";
export { planAgentDefinition } from "./plan";
export { buildAgentDefinition } from "./build";
export { reviewerAgentDefinition } from "./reviewer";
export { exploreAgentDefinition } from "./explore";
export { librarianAgentDefinition } from "./librarian";
export { shaperAgentDefinition } from "./shaper";

import { engineerAgentDefinition } from "./engineer";
import { goalLeadAgentDefinition } from "./goal-lead";
import { planAgentDefinition } from "./plan";
import { buildAgentDefinition } from "./build";
import { reviewerAgentDefinition } from "./reviewer";
import { exploreAgentDefinition } from "./explore";
import { librarianAgentDefinition } from "./librarian";
import { shaperAgentDefinition } from "./shaper";
import type { AgentDefinition } from "../factory-types";

export const agentDefinitions = [
  engineerAgentDefinition,
  goalLeadAgentDefinition,
  planAgentDefinition,
  buildAgentDefinition,
  reviewerAgentDefinition,
  exploreAgentDefinition,
  librarianAgentDefinition,
  shaperAgentDefinition,
] as const satisfies readonly AgentDefinition[];

export const defaultAgentDefinitions = agentDefinitions;
