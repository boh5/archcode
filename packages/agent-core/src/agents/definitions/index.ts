export { orchestratorAgentDefinition } from "./orchestrator";
export { exploreAgentDefinition } from "./explore";
export { productAgentDefinition } from "./product";
export { specAgentDefinition } from "./spec";
export { criticAgentDefinition } from "./critic";
export { foremanAgentDefinition } from "./foreman";
export { builderAgentDefinition } from "./builder";
export { reviewerAgentDefinition } from "./reviewer";
export { librarianAgentDefinition } from "./librarian";

import { orchestratorAgentDefinition } from "./orchestrator";
import { exploreAgentDefinition } from "./explore";
import { productAgentDefinition } from "./product";
import { specAgentDefinition } from "./spec";
import { criticAgentDefinition } from "./critic";
import { foremanAgentDefinition } from "./foreman";
import { builderAgentDefinition } from "./builder";
import { reviewerAgentDefinition } from "./reviewer";
import { librarianAgentDefinition } from "./librarian";

export const agentDefinitions = [
  orchestratorAgentDefinition,
  exploreAgentDefinition,
  productAgentDefinition,
  specAgentDefinition,
  criticAgentDefinition,
  foremanAgentDefinition,
  builderAgentDefinition,
  reviewerAgentDefinition,
  librarianAgentDefinition,
] as const satisfies readonly AgentDefinition[];
export const defaultAgentDefinitions = agentDefinitions;

import type { AgentDefinition } from "../factory-types";
