/** Canonical workspace-relative ownership reference carried by a delegation request. */
export interface ScopeRef {
  kind: "file" | "tree";
  path: string;
}

export type DelegatedAgentType = "plan" | "build" | "reviewer" | "explore" | "librarian";

/**
 * Durable parent-to-child handoff. Business constraints belong in objective;
 * owned_scope is retained solely for Build write-ownership enforcement.
 */
export interface DelegationRequest {
  agent_type: DelegatedAgentType;
  title: string;
  objective: string;
  owned_scope: ScopeRef[];
  skills: string[];
  background: boolean;
}
