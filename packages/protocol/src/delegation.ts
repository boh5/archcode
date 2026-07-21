import type { ProfileName } from "./types";

export type DelegatedAgentType = "analyst" | "build" | "explore" | "librarian";

/**
 * Durable parent-to-child handoff. The selected Profile and Skills are immutable
 * child identity, while task constraints belong in the natural-language objective.
 */
export interface DelegationRequest {
  agent_type: DelegatedAgentType;
  profile: Exclude<ProfileName, "principal">;
  title: string;
  objective: string;
  skills: string[];
  background: boolean;
}
