import type { SessionTreeNode } from "@archcode/protocol";

import type { SessionStoreManager } from "../store/session-store-manager";
import type { SessionExecutionScopeSubject } from "./session-execution-scope-validator";

export interface ResolveSessionExecutionIdentityInput {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly sessions: Pick<SessionStoreManager, "getOrLoad" | "buildSessionTree">;
  /** A new child is validated before its parent link is published. */
  readonly newChild?: boolean;
}

/** Builds one authoritative execution identity from persisted Session state. */
export async function resolveSessionExecutionIdentity(
  input: ResolveSessionExecutionIdentityInput,
): Promise<SessionExecutionScopeSubject> {
  const store = await input.sessions.getOrLoad(input.sessionId, input.workspaceRoot);
  const state = store.getState();
  const parentAgentName = state.parentSessionId === undefined
    ? undefined
    : (await input.sessions.getOrLoad(state.parentSessionId, input.workspaceRoot)).getState().agentName;
  const isDescendantOfRoot = state.goalId !== undefined && state.parentSessionId !== undefined
    ? input.newChild === true || sessionTreeContains(
      (await input.sessions.buildSessionTree(input.workspaceRoot, state.rootSessionId)).root,
      state.sessionId,
    )
    : undefined;

  return {
    sessionId: state.sessionId,
    rootSessionId: state.rootSessionId,
    ...(state.parentSessionId === undefined ? {} : { parentSessionId: state.parentSessionId }),
    ...(parentAgentName === undefined ? {} : { parentAgentName }),
    ...(isDescendantOfRoot === undefined ? {} : { isDescendantOfRoot }),
    cwd: state.cwd,
    ...(state.goalId === undefined ? {} : { goalId: state.goalId }),
    ...(state.sessionRole === undefined ? {} : { sessionRole: state.sessionRole }),
    agentName: state.agentName,
  };
}

function sessionTreeContains(node: SessionTreeNode, sessionId: string): boolean {
  return node.session.sessionId === sessionId
    || node.children.some((child) => sessionTreeContains(child, sessionId));
}
