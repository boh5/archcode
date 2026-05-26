import { SessionStoreManager } from "./session-store-manager";

export { SessionStoreManager };

export const storeManager = new SessionStoreManager();

export function createSessionStore(sessionId: string, workspaceRoot?: string) {
  return new SessionStoreManager().create(sessionId, workspaceRoot);
}
