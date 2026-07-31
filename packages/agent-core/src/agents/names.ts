export const AGENT_NAMES = [
  "lead",
  "discussion",
  "analyst",
  "build",
  "explore",
  "librarian",
] as const;

export type AgentName = (typeof AGENT_NAMES)[number];
