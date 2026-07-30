import type { DelegationRequest } from "@archcode/protocol";
import type { ProfileName } from "../config";
import type { AgentName } from "./names";
import { isUserFacingRootSession } from "./root-session-identity";

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
    if (!isUserFacingRootSession(identity)) {
      throw new Error(`Root Session "${identity.sessionId}" must use a Lead or Discussion Agent with the principal Profile`);
    }
    return "principal";
  }
  const profile = identity.delegationRequest?.profile;
  if (profile === undefined) {
    throw new Error(`Child Session "${identity.sessionId}" has no durable Profile identity`);
  }
  return profile;
}
