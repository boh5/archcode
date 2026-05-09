/**
 * URI / file path conversion utilities for LSP communication.
 *
 * LSP uses `file://` URIs for file references. These utilities handle
 * conversion between absolute file paths and URIs, including percent-encoding
 * of special characters and workspace-gated path resolution.
 */

import path from "node:path";
import { resolveAndValidatePath } from "../tools/security/path-validator";

// ─── URI → Path ───

/**
 * Convert an absolute file path to a `file://` URI.
 *
 * Handles spaces, unicode characters, and all characters that need
 * percent-encoding per RFC 3986.
 *
 * @example
 *   pathToFileUri("/home/user/file.ts")          // "file:///home/user/file.ts"
 *   pathToFileUri("/home/user/my file.ts")       // "file:///home/user/my%20file.ts"
 *   pathToFileUri("/home/user/文件.ts")           // "file:///home/user/%E6%96%87%E4%BB%B6.ts"
 */
export function pathToFileUri(absolutePath: string): string {
  // Normalize backslashes to forward slashes (Windows compat)
  const normalized = absolutePath.replace(/\\/g, "/");

  // Ensure the path starts with a slash (for the authority-less file:/// scheme)
  const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;

  // Encode each path segment individually so / separators remain intact
  const segments = withLeadingSlash.split("/");
  const encoded = segments
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `file://${encoded}`;
}

// ─── Path → URI ───

/**
 * Convert a `file://` URI back to an absolute file path.
 *
 * Handles percent-encoded characters, and strips the `file://` scheme.
 * On Windows, the leading slash before the drive letter is removed.
 *
 * @example
 *   fileUriToPath("file:///home/user/file.ts")       // "/home/user/file.ts"
 *   fileUriToPath("file:///home/user/my%20file.ts")  // "/home/user/my file.ts"
 */
export function fileUriToPath(uri: string): string {
  if (!uri.startsWith("file://")) {
    throw new Error(`Not a file:// URI: ${uri}`);
  }

  const pathPart = uri.slice(7);
  const decoded = decodeURIComponent(pathPart);

  return decoded;
}

// ─── Path normalization within workspace ───

/**
 * Resolve a relative file path against a workspace root.
 *
 * - Normalizes `./` and `../` segments.
 * - Converts backslashes to forward slashes (Windows compat).
 * - Validates the resolved path is within the workspace boundary.
 *
 * @param relativePath - A relative or absolute path to resolve.
 * @param workspaceRoot - Absolute path to the workspace root.
 * @returns The resolved, validated absolute path.
 * @throws {Error} If the resolved path falls outside the workspace.
 *
 * @example
 *   normalizeFilePath("./src/main.ts", "/home/user/project")
 *   // => "/home/user/project/src/main.ts"
 *
 *   normalizeFilePath("../outside.ts", "/home/user/project")
 *   // => Error: Path resolved outside workspace
 */
export function normalizeFilePath(
  relativePath: string,
  workspaceRoot: string,
): string {
  const { resolved, isWithinWorkspace } = resolveAndValidatePath(
    relativePath,
    workspaceRoot,
  );

  if (!isWithinWorkspace) {
    throw new Error(
      `Path "${relativePath}" resolved to "${resolved}" which is outside the workspace root "${workspaceRoot}"`,
    );
  }

  // Normalize backslashes to forward slashes for consistency
  return resolved.replace(/\\/g, "/");
}
