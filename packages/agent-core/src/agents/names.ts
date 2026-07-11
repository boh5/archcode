export const AGENT_NAMES = [
  "engineer",
  "goal_lead",
  "plan",
  "build",
  "reviewer",
  "explore",
  "librarian",
] as const;

export type AgentName = (typeof AGENT_NAMES)[number];
