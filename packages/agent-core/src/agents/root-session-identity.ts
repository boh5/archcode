import type { RootSessionSource } from "@archcode/protocol";
import type { AgentName } from "./names";

export const ROOT_AGENT_NAMES = ["lead", "discussion"] as const;
export type RootAgentName = (typeof ROOT_AGENT_NAMES)[number];

interface SessionIdentity {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly parentSessionId?: string;
  readonly agentName: AgentName;
}

interface SourceBoundSessionIdentity extends SessionIdentity {
  readonly source?: RootSessionSource;
}

export function isRootAgentName(agentName: AgentName): agentName is RootAgentName {
  return (ROOT_AGENT_NAMES as readonly AgentName[]).includes(agentName);
}

export function isUserFacingRootSession(identity: SessionIdentity): boolean {
  return identity.parentSessionId === undefined
    && identity.rootSessionId === identity.sessionId
    && isRootAgentName(identity.agentName);
}

export function isRootLeadSession(identity: SessionIdentity): boolean {
  return isUserFacingRootSession(identity) && identity.agentName === "lead";
}

export function sessionIdentityInvariantError(
  identity: SourceBoundSessionIdentity,
): string | undefined {
  const isRoot = identity.parentSessionId === undefined;
  if (isRoot && identity.rootSessionId !== identity.sessionId) {
    return "Parentless Sessions must own their root Session identity";
  }
  if (!isRoot && identity.rootSessionId === identity.sessionId) {
    return "Child Sessions cannot own their root Session identity";
  }
  if (identity.parentSessionId === identity.sessionId) {
    return "Child Sessions cannot be their own parent";
  }

  if (isRoot && !isRootAgentName(identity.agentName)) {
    return "Root Sessions require a Lead or Discussion Agent";
  }
  if (!isRoot && isRootAgentName(identity.agentName)) {
    return "Lead and Discussion Agents require a root Session";
  }
  if (identity.source !== undefined && !isRoot) {
    return "Session source requires a root Session";
  }
  if (isRoot && identity.source === undefined) {
    return "Root Sessions require an immutable source";
  }
  if (identity.agentName === "discussion") {
    if (identity.source?.kind !== "todo" || identity.source.entry !== "discussion") {
      return "Discussion Sessions require a Discussion Project Todo source";
    }
  } else if (identity.source?.kind === "todo" && identity.source.entry === "discussion") {
    return "Discussion Project Todo sources require the Discussion Agent";
  }
  return undefined;
}
