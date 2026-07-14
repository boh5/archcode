import type { HitlOwnerKey } from "@archcode/protocol";

import { deleteSessionHitlJournalFile } from "./session-hitl-journal-store";
import type { SessionFamilyController } from "./session-family-control";
import type { HitlService } from "../hitl/service";
import type { SessionStoreManager } from "../store/session-store-manager";
import { collectSessionTreeIds } from "./session-tree";

export interface SessionFamilyStopServiceOptions {
  readonly sessionFamilyController: SessionFamilyController;
  readonly sessionStoreManager: SessionStoreManager;
  readonly resolveHitlOwner: (workspaceRoot: string) => Promise<{
    readonly projectSlug: string;
    readonly hitl: HitlService;
  }>;
}

/** Strong family Stop: drain live work, then clear durable Session attention while ownership remains exclusive. */
export class SessionFamilyStopService {
  readonly #sessionFamilyController: SessionFamilyController;
  readonly #sessionStoreManager: SessionStoreManager;
  readonly #resolveHitlOwner: SessionFamilyStopServiceOptions["resolveHitlOwner"];

  constructor(options: SessionFamilyStopServiceOptions) {
    this.#sessionFamilyController = options.sessionFamilyController;
    this.#sessionStoreManager = options.sessionStoreManager;
    this.#resolveHitlOwner = options.resolveHitlOwner;
  }

  async stop(workspaceRoot: string, rootSessionId: string): Promise<void> {
    const lease = this.#sessionFamilyController.acquireStop({ workspaceRoot, rootSessionId });
    try {
      await lease.stopAndWait();
      const [tree, owner] = await Promise.all([
        this.#sessionStoreManager.buildSessionTree(workspaceRoot, rootSessionId),
        this.#resolveHitlOwner(workspaceRoot),
      ]);
      for (const sessionId of collectSessionTreeIds(tree.root)) {
        const hitlOwner: HitlOwnerKey = {
          projectSlug: owner.projectSlug,
          ownerType: "session",
          ownerId: sessionId,
        };
        await owner.hitl.cancelOwner(hitlOwner, "session_family_stopped");
        await this.#sessionStoreManager.clearHitlBlockers(sessionId, workspaceRoot);
        // The entry is the cold-start repair record. Delete it only after
        // the Session snapshot durably proves that its execution blocker is
        // gone; a crash or write failure before this point remains repairable.
        await deleteSessionHitlJournalFile(workspaceRoot, sessionId);
      }
    } finally {
      lease.release();
    }
  }
}
