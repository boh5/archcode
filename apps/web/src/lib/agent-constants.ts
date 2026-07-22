import type { AgentDescriptor } from "@archcode/protocol";

// Stable presentation metadata for the built-in Agent identities. Human-readable
// names intentionally come from GET /api/agents so the runtime remains the
// source of truth for its Agent catalog.

export const AGENT_TYPES = [
  "lead",
  "analyst",
  "build",
  "explore",
  "librarian",
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

export function isValidAgentType(value: string): value is AgentType {
  return (AGENT_TYPES as readonly string[]).includes(value);
}

export function resolveAgentDisplayName(
  agentName: string | null | undefined,
  descriptors: readonly AgentDescriptor[],
): string {
  if (agentName === null || agentName === undefined) return "Loading agent…";
  return descriptors.find((descriptor) => descriptor.name === agentName)?.displayName ?? agentName;
}
