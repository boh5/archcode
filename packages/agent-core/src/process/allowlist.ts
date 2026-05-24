/**
 * Temporary migration allowlist for direct Bun.spawn call sites.
 *
 * These files are intentionally left on direct spawn while ProcessRunner
 * lands in phases. Everything else should migrate away from raw Bun.spawn.
 */
export const DIRECT_BUN_SPAWN_MIGRATION_ALLOWLIST = [
  "packages/agent-core/src/process/**",
  "packages/agent-core/src/lsp/transport.ts",
  "scripts/build.ts",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/__tests__/**",
] as const;

export const DIRECT_BUN_SPAWN_MIGRATION_ALLOWLIST_NOTE =
  "Temporary migration allowlist for direct Bun.spawn call sites that are intentionally not migrated yet.";
