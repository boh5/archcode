import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_SESSIONS_DIR = join(homedir(), ".specra", "sessions");

/**
 * Returns the fixed sessions directory path (`~/.specra/sessions/`).
 * Not configurable via env or config — this path is always used.
 */
export function getSessionsDir(): string {
  return DEFAULT_SESSIONS_DIR;
}
