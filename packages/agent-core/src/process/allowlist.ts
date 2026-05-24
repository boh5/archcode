/**
 * Temporary migration allowlist for direct Bun.spawn call sites.
 *
 * These exceptions are intentionally left on direct spawn while ProcessRunner
 * lands in phases:
 * - process/**: the ProcessRunner implementation itself
 * - lsp/transport.ts: long-lived JSON-RPC stdio ownership
 * - scripts/**: build-time tooling, not runtime code
 * - test files: fixtures and assertions may spawn children
 * Everything else should migrate away from raw Bun.spawn.
 */
export const DIRECT_BUN_SPAWN_MIGRATION_ALLOWLIST = [
  "packages/agent-core/src/process/**",
  "packages/agent-core/src/lsp/transport.ts",
  "scripts/**",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/__tests__/**",
] as const;

export const DIRECT_BUN_SPAWN_MIGRATION_ALLOWLIST_NOTE =
  "Temporary migration allowlist for direct Bun.spawn call sites that are intentionally not migrated yet.";
