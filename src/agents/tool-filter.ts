import type { AnyToolDescriptor } from "../tools/types";
import type { AgentType } from "./agent-registry";
import { DELEGATION_TOOLS, EXPLORER_READ_ONLY_TOOLS } from "./explorer-agent";

export function getToolsForDepth(
  depth: number,
  agentType: AgentType,
  allTools: AnyToolDescriptor[],
): AnyToolDescriptor[] {
  if (agentType !== "explore") {
    return allTools;
  }

  const allowedTools = depth >= 2
    ? new Set<string>(EXPLORER_READ_ONLY_TOOLS)
    : new Set<string>([...EXPLORER_READ_ONLY_TOOLS, ...DELEGATION_TOOLS]);
  return allTools.filter((tool) => allowedTools.has(tool.name));
}
