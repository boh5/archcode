import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_SESSIONS_DIR = join(homedir(), ".specra", "sessions");

let _sessionsDir: string | undefined;

export function getSessionsDir(): string {
  return _sessionsDir ?? DEFAULT_SESSIONS_DIR;
}

export function __setSessionsDirForTest(dir: string | undefined): void {
  _sessionsDir = dir;
}