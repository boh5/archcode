import type { SessionDeletionOwnerDetail, SessionDeletionPreflight, SessionDeletionPreflightInput } from "../execution/session-deletion";
import { SessionDeleteOwnerConflictError } from "../execution/session-deletion";
import { readSessionHitlCheckpointFile } from "../execution/session-hitl-checkpoint";
import { isActiveHitlStatus } from "../hitl/owner-store";
import type { SessionStoreManager } from "../store/session-store-manager";
import type { ProjectContextResolver } from "./context-resolver";

export interface SessionLifecycleServiceOptions {
  readonly storeManager: SessionStoreManager;
  readonly projectContextResolver: Pick<ProjectContextResolver, "resolve">;
}

/** Project-aware Session lifecycle policy kept outside the generic execution manager. */
export class SessionLifecycleService implements SessionDeletionPreflight {
  readonly #storeManager: SessionStoreManager;
  readonly #projectContextResolver: Pick<ProjectContextResolver, "resolve">;

  constructor(options: SessionLifecycleServiceOptions) {
    this.#storeManager = options.storeManager;
    this.#projectContextResolver = options.projectContextResolver;
  }

  async assertDeletable(input: SessionDeletionPreflightInput): Promise<void> {
    const context = await this.#projectContextResolver.resolve(input.workspaceRoot);
    const owners: SessionDeletionOwnerDetail[] = [];

    // The root owner also governs a child-only deletion request. Inspect it even
    // when the selected subtree does not contain the root itself.
    for (const sessionId of [...new Set([input.rootSessionId, ...input.sessionIds])].sort()) {
      const store = await this.#storeManager.getOrLoad(sessionId, input.workspaceRoot);
      const state = store.getState();

      if (state.goalId !== undefined) {
        owners.push({ sessionId, ownerType: "goal", ownerId: state.goalId });
      }
      const sessionOwner = {
        projectSlug: context.project.slug,
        ownerType: "session" as const,
        ownerId: sessionId,
      };
      const activeHitlIds = new Set(
        (await (await context.hitl.ownerStore(sessionOwner)).list())
          .filter((record) => isActiveHitlStatus(record.status))
          .map((record) => record.hitlId),
      );
      for (const hitlId of state.blockedByHitlIds ?? []) activeHitlIds.add(hitlId);
      if (state.blockedHitl !== undefined) activeHitlIds.add(state.blockedHitl.hitlId);
      if (activeHitlIds.size > 0) {
        owners.push({
          sessionId,
          ownerType: "session_hitl",
          ownerId: sessionId,
          hitlIds: [...activeHitlIds].sort(),
        });
      }

      const checkpointHitlIds = (await readSessionHitlCheckpointFile(input.workspaceRoot, sessionId))
        .checkpoints
        .map((checkpoint) => checkpoint.hitlId)
        .sort();
      if (checkpointHitlIds.length > 0) {
        owners.push({
          sessionId,
          ownerType: "session_hitl_checkpoint",
          ownerId: sessionId,
          hitlIds: checkpointHitlIds,
        });
      }
    }

    if (owners.length > 0) throw new SessionDeleteOwnerConflictError(owners);
  }
}
