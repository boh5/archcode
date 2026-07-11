import { SessionStoreManager } from "./session-store-manager";
import { silentLogger } from "../logger";

export { SessionStoreManager };

/** @internal Test-only global store manager. Production code must use injected SessionStoreManager. */
export const storeManager = new SessionStoreManager({ logger: silentLogger });

export function createSessionStore(sessionId: string, workspaceRoot: string) {
  return new SessionStoreManager({ logger: silentLogger }).create(sessionId, workspaceRoot);
}
