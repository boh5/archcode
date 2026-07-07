import type { HitlOwnerKey } from "@archcode/protocol";

import type { GoalStateManager } from "../goals/state";
import type { LoopStateManager } from "../loops/state";
import { getSessionHitlPath } from "../store/sessions-dir";

export interface HitlOwnerPathManagers {
  readonly goalState?: GoalStateManager;
  readonly loopState?: LoopStateManager;
}

export class HitlOwnerPathError extends Error {
  constructor(
    public readonly owner: HitlOwnerKey,
    message: string,
  ) {
    super(message);
    this.name = "HitlOwnerPathError";
  }
}

export async function resolveHitlOwnerPath(
  workspaceRoot: string,
  owner: HitlOwnerKey,
  managers: HitlOwnerPathManagers = {},
): Promise<string> {
  switch (owner.ownerType) {
    case "session":
      return getSessionHitlPath(workspaceRoot, owner.ownerId);
    case "goal": {
      const manager = managers.goalState;
      if (manager === undefined) {
        throw new HitlOwnerPathError(owner, "GoalStateManager is required to resolve Goal HITL path");
      }
      return await manager.goalHitlPath(owner.ownerId);
    }
    case "loop": {
      const manager = managers.loopState;
      if (manager === undefined) {
        throw new HitlOwnerPathError(owner, "LoopStateManager is required to resolve Loop HITL path");
      }
      return await manager.loopHitlPath(owner.ownerId);
    }
  }
}
