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

export type BadgeStatus = "running" | "completed" | "pending" | "error";

export const BADGE_CLASSES: Record<BadgeStatus, string> = {
  running: "bg-success-muted text-success",
  completed: "bg-accent-muted text-accent",
  pending: "bg-bg-active text-text-muted",
  error: "bg-error-muted text-error",
};

export const BADGE_LABELS: Record<BadgeStatus, string> = {
  running: "Running",
  completed: "Completed",
  pending: "Pending",
  error: "Error",
};
