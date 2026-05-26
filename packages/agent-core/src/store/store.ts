import { SessionStoreManager } from "./session-store-manager";

export { SessionStoreManager };

export const storeManager = new SessionStoreManager();

export function scopedKey(workspaceRoot: string, sessionId: string): string {
  return `${workspaceRoot}\0${sessionId}`;
}