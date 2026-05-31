// Agent display constants — single source of truth for agent type metadata
// used across ChatMessages, AttentionQueue, DelegationCard, and Sidebar.
// Uses semantic Tailwind classes (bg-agent-X/text-agent-X) backed by
// CSS custom properties defined in globals.css.

// ─── Agent type list ───

export const AGENT_TYPES = [
  "orchestrator",
  "product",
  "spec",
  "critic",
  "foreman",
  "builder",
  "reviewer",
  "librarian",
  "explorer",
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

// ─── Initials ───

export const AGENT_INITIALS: Record<AgentType, string> = {
  orchestrator: "O",
  product: "P",
  spec: "S",
  critic: "C",
  foreman: "F",
  builder: "B",
  reviewer: "R",
  librarian: "L",
  explorer: "E",
};

// ─── Display names ───

export const AGENT_DISPLAY_NAMES: Record<AgentType, string> = {
  orchestrator: "Orchestrator",
  product: "Product",
  spec: "Spec",
  critic: "Critic",
  foreman: "Foreman",
  builder: "Builder",
  reviewer: "Reviewer",
  librarian: "Librarian",
  explorer: "Explorer",
};

// ─── Icon color classes (semantic Tailwind) ───

export const AGENT_ICON_COLORS: Record<AgentType, string> = {
  orchestrator: "bg-agent-orchestrator/20 text-agent-orchestrator",
  product: "bg-agent-product/20 text-agent-product",
  spec: "bg-agent-spec/20 text-agent-spec",
  critic: "bg-agent-critic/20 text-agent-critic",
  foreman: "bg-agent-foreman/20 text-agent-foreman",
  builder: "bg-agent-builder/20 text-agent-builder",
  reviewer: "bg-agent-reviewer/20 text-agent-reviewer",
  librarian: "bg-agent-librarian/20 text-agent-librarian",
  explorer: "bg-agent-explorer/20 text-agent-explorer",
};

// ─── Badge colors (used in AttentionQueue) ───
// Same semantic tokens as AGENT_ICON_COLORS — AttentionQueue previously
// used raw hex with /20 opacity; semantic classes handle both themes.

export const AGENT_BADGE_COLORS: Record<AgentType, string> = AGENT_ICON_COLORS;

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