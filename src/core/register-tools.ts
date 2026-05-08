import type { ToolRegistry } from "../tools/index";

/**
 * Register all built-in tools onto the given registry.
 *
 * Remains a no-op for Tier 0 — built-in tools (file read/write, search,
 * shell, etc.) are out of scope until later tiers.  When built-ins are
 * added, they should live under `core/` and be registered here.
 */
export function registerBuiltinTools(registry: ToolRegistry): void {
  // TODO: register built-in tools when implemented
}