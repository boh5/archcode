import type { RequestedModelSelection, SessionModelSelection } from "@archcode/protocol";
import type { SessionInputStorePort } from "./service";

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

/** Owns the Session-local model override and its revision-CAS mutation boundary. */
export class SessionModelSelectionService {
  constructor(private readonly store: SessionInputStorePort) {}

  async get(sessionId: string, workspaceRoot: string): Promise<SessionModelSelection> {
    const state = await this.store.getSessionFile(workspaceRoot, sessionId);
    return copySelection(state.modelSelection);
  }

  async patch(input: {
    sessionId: string;
    workspaceRoot: string;
    expectedRevision: number;
    requestedModelSelection: RequestedModelSelection;
  }): Promise<SessionModelSelection> {
    return await this.store.commitDurableSessionMutation(input.sessionId, input.workspaceRoot, (state) => {
      if (state.modelSelection.revision !== input.expectedRevision) {
        throw new SessionModelSelectionConflictError(
          input.expectedRevision,
          copySelection(state.modelSelection),
        );
      }
      const modelSelection: SessionModelSelection = input.requestedModelSelection.mode === "agent_default"
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

function copySelection(selection: SessionModelSelection): SessionModelSelection {
  return {
    revision: selection.revision,
    ...(selection.override === undefined ? {} : { override: { ...selection.override } }),
  };
}
