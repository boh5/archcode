import type { AgentDescriptor } from "@archcode/protocol";

// Stable presentation metadata for the built-in Agent identities. Human-readable
// names intentionally come from GET /api/agents so the runtime remains the
// source of truth for its Agent catalog.

export const AGENT_TYPES = [
  "engineer",
  "goal_lead",
  "plan",
  "build",
  "reviewer",
  "explore",
  "librarian",
  "shaper",
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

export const AGENT_ICON_COLORS: Record<AgentType, string> = {
  engineer: "bg-agent-engineer/20 text-agent-engineer",
  goal_lead: "bg-agent-goal-lead/20 text-agent-goal-lead",
  plan: "bg-agent-plan/20 text-agent-plan",
  build: "bg-agent-build/20 text-agent-build",
  reviewer: "bg-agent-reviewer/20 text-agent-reviewer",
  explore: "bg-agent-explore/20 text-agent-explore",
  librarian: "bg-agent-librarian/20 text-agent-librarian",
  shaper: "bg-agent-shaper/20 text-agent-shaper",
};

export const AGENT_BADGE_COLORS: Record<AgentType, string> = AGENT_ICON_COLORS;

export const AGENT_BORDER_CLASS: Record<AgentType, string> = {
  engineer: "border-agent-engineer",
  goal_lead: "border-agent-goal-lead",
  plan: "border-agent-plan",
  build: "border-agent-build",
  reviewer: "border-agent-reviewer",
  explore: "border-agent-explore",
  librarian: "border-agent-librarian",
  shaper: "border-agent-shaper",
};

export function isValidAgentType(value: string): value is AgentType {
  return (AGENT_TYPES as readonly string[]).includes(value);
}

export interface AgentAppearance {
  initial: string;
  iconClass: string;
  borderClass: string;
}

const UNKNOWN_AGENT_APPEARANCE = {
  iconClass: "bg-bg-active text-text-muted",
  borderClass: "border-border-default",
} as const;

export function resolveAgentInitial(displayName: string | null | undefined): string {
  return displayName?.trim().slice(0, 1).toUpperCase() || "?";
}

export function resolveAgentAppearance(
  agentName: string | null | undefined,
  displayName: string | null | undefined = agentName,
): AgentAppearance {
  if (agentName !== null && agentName !== undefined && isValidAgentType(agentName)) {
    return {
      initial: resolveAgentInitial(displayName),
      iconClass: AGENT_ICON_COLORS[agentName],
      borderClass: AGENT_BORDER_CLASS[agentName],
    };
  }

  return {
    initial: resolveAgentInitial(displayName),
    ...UNKNOWN_AGENT_APPEARANCE,
  };
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
