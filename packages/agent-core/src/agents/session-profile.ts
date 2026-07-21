import type { DelegationRequest } from "@archcode/protocol";
import type { ProfileName } from "../config";
import type { AgentName } from "./names";

export interface SessionProfileIdentity {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly parentSessionId?: string;
  readonly agentName: AgentName;
  readonly delegationRequest?: DelegationRequest;
}

/** Derives the immutable Profile from canonical Session identity. */
export function resolveSessionProfile(identity: SessionProfileIdentity): ProfileName {
  if (identity.parentSessionId === undefined) {
    if (identity.agentName !== "lead" || identity.rootSessionId !== identity.sessionId) {
      throw new Error(`Root Session "${identity.sessionId}" must be a Lead using the principal Profile`);
    }
    return "principal";
  }
  const profile = identity.delegationRequest?.profile;
  if (profile === undefined) {
    throw new Error(`Child Session "${identity.sessionId}" has no durable Profile identity`);
  }
  return profile;
}
