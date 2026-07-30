import type { ProjectTodoSessionSource } from "@archcode/protocol";
import type { AgentName } from "./names";

export const ROOT_AGENT_NAMES = ["lead", "discussion"] as const;
export type RootAgentName = (typeof ROOT_AGENT_NAMES)[number];

interface SessionIdentity {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly parentSessionId?: string;
  readonly agentName: AgentName;
}

interface ProjectTodoBoundSessionIdentity extends SessionIdentity {
  readonly projectTodo?: ProjectTodoSessionSource;
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
  identity: ProjectTodoBoundSessionIdentity,
): string | undefined {
  const isRoot = identity.parentSessionId === undefined
    && identity.rootSessionId === identity.sessionId;

  if (isRoot && !isRootAgentName(identity.agentName)) {
    return "Root Sessions require a Lead or Discussion Agent";
  }
  if (!isRoot && isRootAgentName(identity.agentName)) {
    return "Lead and Discussion Agents require a root Session";
  }
  if (identity.projectTodo !== undefined && !isRoot) {
    return "Project Todo source requires a root Session";
  }
  if (identity.agentName === "discussion") {
    if (identity.projectTodo?.entry !== "discussion") {
      return "Discussion Sessions require a Discussion Project Todo source";
    }
  } else if (identity.projectTodo?.entry === "discussion") {
    return "Discussion Project Todo sources require the Discussion Agent";
  }
  return undefined;
}
