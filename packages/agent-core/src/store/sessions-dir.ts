import { join, resolve, sep } from "node:path";

let _override: ((workspaceRoot: string) => string) | undefined;

export function getSessionsDir(workspaceRoot: string): string {
  if (_override) return _override(workspaceRoot);
  return join(workspaceRoot, ".specra", "sessions");
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
 * Returns the file path for a root session JSON file.
 * Pattern: `.specra/sessions/{sessionId}.json`
 */
export function getRootSessionPath(workspaceRoot: string, sessionId: string): string {
  assertSafeSessionId(sessionId);
  const sessionsDir = getSessionsDir(workspaceRoot);
  const path = join(sessionsDir, `${sessionId}.json`);
  assertPathContained(path, sessionsDir);
  return path;
}

/**
 * Returns the directory path for a root session's descendant tree.
 * Pattern: `.specra/sessions/{rootSessionId}`
 */
export function getRootSessionDir(workspaceRoot: string, rootSessionId: string): string {
  assertSafeSessionId(rootSessionId);
  const sessionsDir = getSessionsDir(workspaceRoot);
  const path = join(sessionsDir, rootSessionId);
  assertPathContained(path, sessionsDir);
  return path;
}

/**
 * Returns the file path for a child session JSON file nested under its root.
 * Pattern: `.specra/sessions/{rootSessionId}/{sessionId}.json`
 */
export function getChildSessionPath(
  workspaceRoot: string,
  rootSessionId: string,
  sessionId: string,
): string {
  assertSafeSessionId(rootSessionId);
  assertSafeSessionId(sessionId);
  const sessionsDir = getSessionsDir(workspaceRoot);
  const path = join(sessionsDir, rootSessionId, `${sessionId}.json`);
  assertPathContained(path, sessionsDir);
  return path;
}

/**
 * Returns the correct session file path based on whether the session
 * is the root (`rootSessionId === sessionId`) or a descendant.
 */
export function getSessionPath(
  workspaceRoot: string,
  rootSessionId: string,
  sessionId: string,
): string {
  if (rootSessionId === sessionId) {
    return getRootSessionPath(workspaceRoot, sessionId);
  }
  return getChildSessionPath(workspaceRoot, rootSessionId, sessionId);
}

export function __setSessionsDirForTest(
  fn: ((workspaceRoot: string) => string) | undefined,
): void {
  _override = fn;
}

export function __hasSessionsDirOverrideForTest(): boolean {
  return _override !== undefined;
}
