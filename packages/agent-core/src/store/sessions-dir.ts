import { join, resolve, sep } from "node:path";
import { PROJECT_STATE_DIR_NAME } from "@archcode/protocol";

let _override: ((workspaceRoot: string) => string) | undefined;

export function getSessionsDir(workspaceRoot: string): string {
  if (_override) return _override(workspaceRoot);
  return join(workspaceRoot, PROJECT_STATE_DIR_NAME, "sessions");
}

/**
 * UUID v1–5 regex. Accepts only standard UUID format with valid variant nibble.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates that a session ID is a safe, well-formed UUID.
 *
 * Rejects empty strings, `.`, `..`, strings containing `/` or `\`,
 * URL-encoded traversal patterns (%2e, %2f, %5c), and any value that
 * does not match UUID format.
 */
export function assertSafeSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("Invalid session ID: must be a non-empty string");
  }
  if (sessionId === "." || sessionId === "..") {
    throw new Error(`Invalid session ID: "${sessionId}" is not allowed`);
  }
  if (sessionId.includes("/") || sessionId.includes("\\")) {
    throw new Error("Invalid session ID: must not contain path separators");
  }
  // Reject URL-encoded path traversal (%2e = '.', %2f = '/', %5c = '\')
  if (
    /%2[eE]|%2[fF]|%5[cC]/.test(sessionId)
  ) {
    throw new Error("Invalid session ID: must not contain URL-encoded path characters");
  }
  if (!UUID_RE.test(sessionId)) {
    throw new Error("Invalid session ID: must be a valid UUID");
  }
}

/**
 * Verifies that `target` resolves to a path under `parent`.
 * Uses absolute resolution to catch any traversal edge cases.
 */
function assertPathContained(target: string, parent: string): void {
  const resolvedTarget = resolve(target);
  const resolvedParent = resolve(parent);
  if (!resolvedTarget.startsWith(resolvedParent + sep)) {
    throw new Error(
      `Path containment violation: "${target}" is not under "${parent}"`,
    );
  }
}

/**
 * Returns the canonical directory for one session owner.
 * Pattern: `.archcode/sessions/{sessionId}`
 */
export function getSessionDir(workspaceRoot: string, sessionId: string): string {
  assertSafeSessionId(sessionId);
  const sessionsDir = getSessionsDir(workspaceRoot);
  const path = join(sessionsDir, sessionId);
  assertPathContained(path, sessionsDir);
  return path;
}

/**
 * Returns the canonical session file path.
 * Pattern: `.archcode/sessions/{sessionId}/session.json`
 */
export function getSessionPath(workspaceRoot: string, sessionId: string): string {
  assertSafeSessionId(sessionId);
  const sessionDir = getSessionDir(workspaceRoot, sessionId);
  const path = join(sessionDir, "session.json");
  assertPathContained(path, sessionDir);
  return path;
}

/**
 * Returns the owner-local HITL file path for one session.
 * Pattern: `.archcode/sessions/{sessionId}/hitl.json`
 */
export function getSessionHitlPath(workspaceRoot: string, sessionId: string): string {
  assertSafeSessionId(sessionId);
  const sessionDir = getSessionDir(workspaceRoot, sessionId);
  const path = join(sessionDir, "hitl.json");
  assertPathContained(path, sessionDir);
  return path;
}

export function __setSessionsDirForTest(
  fn: ((workspaceRoot: string) => string) | undefined,
): void {
  _override = fn;
}

export function __hasSessionsDirOverrideForTest(): boolean {
  return _override !== undefined;
}
