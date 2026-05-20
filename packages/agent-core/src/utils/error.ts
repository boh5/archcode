/**
 * Extract the system error code from an error thrown by Bun file APIs.
 *
 * Bun throws `SystemError` for filesystem operations (ENOENT, EACCES, etc.).
 * This helper safely extracts the `.code` string from such errors without
 * requiring a direct cast to `Bun.SystemError`.
 */
export function getSystemErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}