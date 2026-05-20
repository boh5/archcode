/**
 * Secret detection patterns extracted from the redaction system.
 *
 * These patterns are used both by the redaction hook (to mask secrets in
 * tool output) and by the memory-write tool (to reject writes that contain
 * obvious secrets).
 */

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Matches key names that commonly hold secrets (api_key, password, token, etc.) */
export const SENSITIVE_KEY_PATTERN =
  /(?:api[_-]?key|auth|authorization|bearer|client[_-]?secret|credential|pass(?:word)?|secret|token)/i;

/** Matches well-known token prefixes followed by 8+ base64/hex chars */
export const TOKEN_PATTERN =
  /\b(?:sk|pk|ghp|github_pat|xox[baprs]|AKIA|ASIA|SG)_[A-Za-z0-9_=-]{8,}\b|\b(?:sk|pk|ghp|github_pat|xox[baprs]|AKIA|ASIA|SG)-[A-Za-z0-9_=-]{8,}\b|\b[A-Za-z0-9+/]{32,}={0,2}\b/g;

/** Matches assignment patterns like `api_key=VALUE` or `token: VALUE` */
export const ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_-]*(?:api[_-]?key|auth|authorization|bearer|client[_-]?secret|credential|pass(?:word)?|secret|token)[A-Za-z0-9_-]*\s*[=:]\s*)([^\s&;,]+)/gi;

// ---------------------------------------------------------------------------
// Secret detection
// ---------------------------------------------------------------------------

export interface SecretDetectionResult {
  found: boolean;
  patterns: string[];
}

/**
 * Check whether content contains obvious secret patterns.
 *
 * Returns an object with:
 * - `found`: true if any secret pattern was detected
 * - `patterns`: list of pattern names that matched
 */
export function containsSecretPattern(content: string): SecretDetectionResult {
  const matched: string[] = [];

  // Check assignment pattern (key=value where key is sensitive)
  // Reset lastIndex since TOKEN_PATTERN and ASSIGNMENT_PATTERN are stateful
  ASSIGNMENT_PATTERN.lastIndex = 0;
  if (ASSIGNMENT_PATTERN.test(content)) {
    matched.push("assignment");
  }

  // Check token pattern (well-known token prefixes)
  TOKEN_PATTERN.lastIndex = 0;
  if (TOKEN_PATTERN.test(content)) {
    matched.push("token");
  }

  return {
    found: matched.length > 0,
    patterns: matched,
  };
}