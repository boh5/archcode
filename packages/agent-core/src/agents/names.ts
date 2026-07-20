export const AGENT_NAMES = [
  "engineer",
  "plan",
  "build",
  "reviewer",
  "explore",
  "librarian",
  "shaper",
] as const;

export type AgentName = (typeof AGENT_NAMES)[number];
