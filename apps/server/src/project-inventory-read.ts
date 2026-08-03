import type { AgentRuntime } from "@archcode/agent-core";
import type {
  LatestExecutionDigest,
  ProjectAutomationInventoryItem,
  ProjectSessionInventoryItem,
  SessionExecutionRecord,
} from "@archcode/protocol";

export async function readProjectSessionInventory(
  runtime: AgentRuntime,
  workspaceRoot: string,
): Promise<ProjectSessionInventoryItem[]> {
  return await runtime.listSessionInventory(workspaceRoot);
}

export async function readProjectAutomationInventory(
  runtime: AgentRuntime,
  workspaceRoot: string,
): Promise<ProjectAutomationInventoryItem[]> {
  return await runtime.listAutomationInventory(workspaceRoot);
}

export function toLatestExecutionDigest(
  execution: SessionExecutionRecord | undefined,
): LatestExecutionDigest | null {
  if (execution === undefined) return null;
  return {
    id: execution.id,
    status: execution.status,
    startedAt: execution.startedAt,
    ...(execution.endedAt === undefined ? {} : { endedAt: execution.endedAt }),
  };
}
