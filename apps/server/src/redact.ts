export function redactPublicString(value: string): string {
  return value
    .replace(/\b(?:gh[opsur]_|github_pat_)[A-Za-z0-9_]{8,}\b/g, "[REDACTED:SECRET]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED:SECRET]")
    .replace(/\b[A-Za-z0-9_-]*(?:api[_-]?key|auth|authorization|bearer|client[_-]?secret|credential|pass(?:word)?|secret|token)[A-Za-z0-9_-]*\s*[=:]\s*[^\s&;,]+/gi, (match) => {
      const separatorIndex = Math.max(match.lastIndexOf("="), match.lastIndexOf(":"));
      if (separatorIndex < 0) return "[REDACTED:SECRET]";
      return `${match.slice(0, separatorIndex + 1)}[REDACTED:SECRET]`;
    });
}
