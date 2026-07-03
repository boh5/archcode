import type { LoopConfig } from "./state";

// ---------------------------------------------------------------------------
// Preset ID constants
// ---------------------------------------------------------------------------

/** All 7 loop presets defined in the Phase 3 spec. */
export const LOOP_PRESET_IDS = [
  "daily_triage",
  "changelog_drafter",
  "pr_babysitter",
  "ci_sweeper",
  "dependency_sweeper",
  "post_merge_cleanup",
  "issue_triage",
] as const;

/** The 2 presets fully usable in Phase 3 (local-only, no external connectors). */
export const SUPPORTED_LOOP_PRESET_IDS = [
  "daily_triage",
  "changelog_drafter",
] as const;

export type LoopPresetId = (typeof LOOP_PRESET_IDS)[number];
export type SupportedLoopPresetId = (typeof SUPPORTED_LOOP_PRESET_IDS)[number];

// ---------------------------------------------------------------------------
// Unsupported preset reasons
// ---------------------------------------------------------------------------

const UNSUPPORTED_REASONS: Record<string, string> = {
  pr_babysitter:
    "Requires GitHub connector (Phase 4): PR list, diff, review comments, and merge babysitting are not available in local-only mode.",
  ci_sweeper:
    "Requires CI connector (Phase 4): CI run status and failure log summaries are not available in local-only mode.",
  dependency_sweeper:
    "Requires CI connector (Phase 4): dependency update scanning and vulnerability detection need external data sources.",
  post_merge_cleanup:
    "Requires GitHub connector (Phase 4): post-merge branch cleanup and issue tracking are not available in local-only mode.",
  issue_triage:
    "Requires GitHub connector (Phase 4): issue deduplication, scoring, and label suggestions need external issue tracker access.",
};

// ---------------------------------------------------------------------------
// Preset expansion helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the preset id is one of the two Phase 3 runnable presets.
 */
export function isSupportedLoopPreset(id: string): id is SupportedLoopPresetId {
  return (SUPPORTED_LOOP_PRESET_IDS as readonly string[]).includes(id);
}

/**
 * Returns a human-readable reason string when a preset id is recognised but
 * unsupported in Phase 3, or `undefined` if the id is supported or unknown.
 */
export function getUnsupportedLoopPresetReason(id: string): string | undefined {
  return UNSUPPORTED_REASONS[id];
}

/**
 * Expands a preset id into a full `LoopConfig` with sensible defaults.
 *
 * @throws `RangeError` when the preset id is recognised but unsupported
 *         (requires external connectors not available in Phase 3).
 * @throws `RangeError` when the preset id is not recognised at all.
 */
export function expandLoopPreset(id: string): LoopConfig {
  switch (id) {
    case "daily_triage":
      return expandDailyTriage();
    case "changelog_drafter":
      return expandChangelogDrafter();
    default: {
      const reason = getUnsupportedLoopPresetReason(id);
      if (reason !== undefined) {
        throw new RangeError(`Unsupported loop preset "${id}": ${reason}`);
      }
      throw new RangeError(`Unknown loop preset "${id}". Valid ids: ${LOOP_PRESET_IDS.join(", ")}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Individual preset expanders
// ---------------------------------------------------------------------------

function expandDailyTriage(): LoopConfig {
  return {
    title: "Daily Triage",
    description: "Local-only daily triage: inspect git status, TODO/FIXME, typecheck and test results, and produce a triage report.",
    schedule: { kind: "manual" },
    runKind: "session",
    mode: "report",
    approvalPolicy: "interactive",
    limits: { maxIterationsPerRun: 8 },
    taskPrompt:
      "Run a local-only daily triage:\n" +
      "1. Run `git status` and `git log --oneline -10` to inspect current branch state.\n" +
      "2. Search for TODO, FIXME, HACK, and WORKAROUND comments in the codebase.\n" +
      "3. Run `bun run typecheck` and `bun test` to check project health.\n" +
      "4. Summarise findings in a triage report: open issues, stale branches, failing checks, and accumulated tech debt.\n" +
      "Do not push, create PRs, or call any external API.",
    sourcePreset: "daily_triage",
  };
}

function expandChangelogDrafter(): LoopConfig {
  return {
    title: "Changelog Drafter",
    description: "Local-only changelog draft: inspect git history and diff since last run, then draft changelog text.",
    schedule: { kind: "manual" },
    runKind: "session",
    mode: "report",
    approvalPolicy: "interactive",
    limits: { maxIterationsPerRun: 8 },
    taskPrompt:
      "Draft a changelog from local git history:\n" +
      "1. Run `git log --oneline --no-decorate -30` to see recent commits.\n" +
      "2. Run `git diff --stat HEAD~10..HEAD` to see what files changed recently.\n" +
      "3. Categorise changes into: Features, Fixes, Refactors, Documentation, Chores.\n" +
      "4. Draft a human-readable changelog entry for the period since the last run.\n" +
      "Do not push, create PRs, create releases, or call any external API.",
    sourcePreset: "changelog_drafter",
  };
}
