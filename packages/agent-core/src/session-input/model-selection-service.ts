import type { ModelSelectionRef, RequestedModelSelection, SessionModelSelection } from "@archcode/protocol";
import type { SessionStoreState } from "../store/types";
import type { SessionInputDurableMutation } from "./service";

export class SessionModelSelectionConflictError extends Error {
  constructor(
    public readonly expectedRevision: number,
    public readonly current: SessionModelSelection,
  ) {
    super(`Session model selection revision is ${current.revision}, expected ${expectedRevision}`);
    this.name = "SessionModelSelectionConflictError";
  }
}

export class SessionModelSelectionInvalidError extends Error {
  constructor(public readonly requested: RequestedModelSelection) {
    super(`Unknown model selection "${requested.selection.model}"`);
    this.name = "SessionModelSelectionInvalidError";
  }
}

export class SessionModelSelectionNotAllowedError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly reason: "not_root_lead",
  ) {
    super(`Session model overrides belong only to a root Lead Session; "${sessionId}" is not eligible`);
    this.name = "SessionModelSelectionNotAllowedError";
  }
}

interface SessionModelSelectionStorePort {
  getSessionFile(
    workspaceRoot: string,
    sessionId: string,
  ): Promise<Pick<
    SessionStoreState,
    "sessionId" | "rootSessionId" | "parentSessionId" | "agentName" | "modelSelection"
  >>;
  commitDurableSessionMutation<T>(
    sessionId: string,
    workspaceRoot: string,
    mutate: (state: Readonly<SessionStoreState>) => SessionInputDurableMutation<T>,
  ): Promise<T>;
}

type DurableModelSelectionIdentity = Pick<
  SessionStoreState,
  "sessionId" | "rootSessionId" | "parentSessionId" | "agentName" | "modelSelection"
>;

/**
 * Returns the durable override only for a root Lead. Child model identity comes
 * exclusively from its delegated Profile, so any mutable selection state is a
 * corrupt identity rather than a fallback candidate.
 */
export function resolveDurableSessionModelOverride(
  state: DurableModelSelectionIdentity,
): ModelSelectionRef | undefined {
  if (!isRootLead(state)) {
    if (state.modelSelection.revision !== 0 || state.modelSelection.override !== undefined) {
      throw new SessionModelSelectionNotAllowedError(state.sessionId, "not_root_lead");
    }
    return undefined;
  }
  return state.modelSelection.override;
}

/** Owns the root Lead Session-local model override and its revision-CAS mutation boundary. */
export class SessionModelSelectionService {
  constructor(private readonly store: SessionModelSelectionStorePort) {}

  async get(sessionId: string, workspaceRoot: string): Promise<SessionModelSelection> {
    const state = await this.store.getSessionFile(workspaceRoot, sessionId);
    resolveDurableSessionModelOverride(state);
    return copySelection(state.modelSelection);
  }

  async patch(input: {
    sessionId: string;
    workspaceRoot: string;
    expectedRevision: number;
    requestedModelSelection: RequestedModelSelection;
  }): Promise<SessionModelSelection> {
    const current = await this.store.getSessionFile(input.workspaceRoot, input.sessionId);
    assertRootLeadSelectionOwner(current);
    return await this.store.commitDurableSessionMutation(input.sessionId, input.workspaceRoot, (state) => {
      assertRootLeadSelectionOwner(state);
      if (state.modelSelection.revision !== input.expectedRevision) {
        throw new SessionModelSelectionConflictError(
          input.expectedRevision,
          copySelection(state.modelSelection),
        );
      }
      const modelSelection: SessionModelSelection = input.requestedModelSelection.mode === "profile_default"
        ? { revision: state.modelSelection.revision + 1 }
        : {
            revision: state.modelSelection.revision + 1,
            override: { ...input.requestedModelSelection.selection },
          };
      return {
        result: copySelection(modelSelection),
        events: [{ type: "session.model_selection_changed", modelSelection }],
      };
    });
  }
}

function assertRootLeadSelectionOwner(state: DurableModelSelectionIdentity): void {
  if (!isRootLead(state)) {
    throw new SessionModelSelectionNotAllowedError(state.sessionId, "not_root_lead");
  }
}

function isRootLead(state: DurableModelSelectionIdentity): boolean {
  return state.agentName === "lead"
    && state.parentSessionId === undefined
    && state.rootSessionId === state.sessionId;
}

function copySelection(selection: SessionModelSelection): SessionModelSelection {
  return {
    revision: selection.revision,
    ...(selection.override === undefined ? {} : { override: { ...selection.override } }),
  };
}
