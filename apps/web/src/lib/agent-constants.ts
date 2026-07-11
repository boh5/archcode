// Agent display constants — single source of truth for agent type metadata
// used across ChatMessages, DelegationCard, and Sidebar.
// Uses semantic Tailwind classes (bg-agent-X/text-agent-X) backed by
// CSS custom properties defined in globals.css.

// ─── Agent type list ───

export const AGENT_TYPES = [
  "orchestrator",
  "plan",
  "build",
  "reviewer",
  "explore",
  "librarian",
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

// ─── Initials ───

export const AGENT_INITIALS: Record<AgentType, string> = {
  orchestrator: "O",
  plan: "P",
  build: "B",
  reviewer: "R",
  explore: "E",
  librarian: "L",
};

// ─── Display names ───

export const AGENT_DISPLAY_NAMES: Record<AgentType, string> = {
  orchestrator: "Orchestrator",
  plan: "Plan",
  build: "Build",
  reviewer: "Reviewer",
  explore: "Explore",
  librarian: "Librarian",
};

// ─── Icon color classes (semantic Tailwind) ───

export const AGENT_ICON_COLORS: Record<AgentType, string> = {
  orchestrator: "bg-agent-orchestrator/20 text-agent-orchestrator",
  plan: "bg-agent-plan/20 text-agent-plan",
  build: "bg-agent-build/20 text-agent-build",
  reviewer: "bg-agent-reviewer/20 text-agent-reviewer",
  explore: "bg-agent-explore/20 text-agent-explore",
  librarian: "bg-agent-librarian/20 text-agent-librarian",
};

// ─── Badge colors (semantic tokens shared with AGENT_ICON_COLORS) ───
// Same semantic tokens as AGENT_ICON_COLORS.

export const AGENT_BADGE_COLORS: Record<AgentType, string> = AGENT_ICON_COLORS;

export const AGENT_DOT_CLASS: Record<AgentType, string> = {
  orchestrator: "bg-agent-orchestrator",
  plan: "bg-agent-plan",
  build: "bg-agent-build",
  reviewer: "bg-agent-reviewer",
  explore: "bg-agent-explore",
  librarian: "bg-agent-librarian",
};

export const AGENT_NAME_CLASS: Record<AgentType, string> = {
  orchestrator: "text-agent-orchestrator font-semibold",
  plan: "text-agent-plan font-semibold",
  build: "text-agent-build font-semibold",
  reviewer: "text-agent-reviewer font-semibold",
  explore: "text-agent-explore font-semibold",
  librarian: "text-agent-librarian font-semibold",
};

export const AGENT_BORDER_CLASS: Record<AgentType, string> = {
  orchestrator: "border-agent-orchestrator",
  plan: "border-agent-plan",
  build: "border-agent-build",
  reviewer: "border-agent-reviewer",
  explore: "border-agent-explore",
  librarian: "border-agent-librarian",
};

// ─── Type guard ───

export function isValidAgentType(value: string): value is AgentType {
  return (AGENT_TYPES as readonly string[]).includes(value);
}

// ─── Badge status (from DelegationCard) ───

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
