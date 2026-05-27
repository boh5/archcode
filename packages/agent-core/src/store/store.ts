import { SessionStoreManager } from "./session-store-manager";
import { silentLogger } from "../logger";

export { SessionStoreManager };

export const storeManager = new SessionStoreManager({ logger: silentLogger });

export function createSessionStore(sessionId: string, workspaceRoot?: string) {
  return new SessionStoreManager({ logger: silentLogger }).create(sessionId, workspaceRoot);
}
