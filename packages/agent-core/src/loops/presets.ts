import type { LoopBudgetConfig, LoopConfig, LoopGoalTemplate } from "./state";

// ---------------------------------------------------------------------------
// Preset ID constants
// ---------------------------------------------------------------------------

/** All 7 loop presets defined for editable quick-start templates. */
export const LOOP_PRESET_IDS = [
  "daily_triage",
  "changelog_drafter",
  "pr_babysitter",
  "ci_sweeper",
  "dependency_sweeper",
  "post_merge_cleanup",
  "issue_triage",
] as const;

/** Stable Loop API supports every preset id as a create-time editable template. */
export const SUPPORTED_LOOP_PRESET_IDS = LOOP_PRESET_IDS;

export type LoopPresetId = (typeof LOOP_PRESET_IDS)[number];
export type SupportedLoopPresetId = (typeof SUPPORTED_LOOP_PRESET_IDS)[number];

const MINUTE_MS = 60_000;

// ---------------------------------------------------------------------------
// Preset expansion helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the preset id is one of the editable quick-start templates.
 */
export function isSupportedLoopPreset(id: string): id is SupportedLoopPresetId {
  return (SUPPORTED_LOOP_PRESET_IDS as readonly string[]).includes(id);
}

/**
 * Presets are templates rather than unsupported runtime categories.
 * This API remains for server compatibility and only returns a reason if a
 * future recognised id is intentionally gated.
 */
export function getUnsupportedLoopPresetReason(id: string): string | undefined {
  void id;
  return undefined;
}

/**
 * Expands a preset id into a full editable `LoopConfig` template.
 *
 * Stored config fields such as `runKind`, `mode`, and `toolProfileId` drive
 * runtime behavior after creation. The preset id remains metadata only.
 *
 * @throws `RangeError` when the preset id is not recognised.
 */
export function expandLoopPreset(id: string): LoopConfig {
  switch (id) {
    case "daily_triage":
      return expandDailyTriage();
    case "changelog_drafter":
      return expandChangelogDrafter();
    case "pr_babysitter":
      return expandPrBabysitter();
    case "ci_sweeper":
      return expandCiSweeper();
    case "dependency_sweeper":
      return expandDependencySweeper();
    case "post_merge_cleanup":
      return expandPostLandCleanup();
    case "issue_triage":
      return expandIssueTriage();
    default:
      throw new RangeError(`Unknown loop preset "${id}". Valid ids: ${LOOP_PRESET_IDS.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// Individual preset expanders
// ---------------------------------------------------------------------------

function expandDailyTriage(): LoopConfig {
  return createPreset({
    sourcePreset: "daily_triage",
    title: "Daily Triage",
    description: "Local daily triage: inspect git status, TODO/FIXME comments, typecheck and test results, and produce a triage report.",
    runKind: "session",
    mode: "report",
    toolProfileId: "loop_local_report",
    limits: presetBudget(8, 120_000, 15, 2),
    taskPrompt:
      "Run a local daily triage:\n" +
      "1. Run `git status` and `git log --oneline -10` to inspect current branch state.\n" +
      "2. Search for TODO, FIXME, HACK, and WORKAROUND comments in the codebase.\n" +
      "3. Run `bun run typecheck` and `bun test` to check project health.\n" +
      "4. Summarise findings in a triage report: open issues, stale branches, failing checks, and accumulated tech debt.\n" +
      "Do not publish changes, create PRs, or call external APIs.",
  });
}

function expandChangelogDrafter(): LoopConfig {
  return createPreset({
    sourcePreset: "changelog_drafter",
    title: "Changelog Drafter",
    description: "Local changelog draft: inspect git history and diff since the last run, then draft changelog text.",
    runKind: "session",
    mode: "report",
    toolProfileId: "loop_local_report",
    limits: presetBudget(8, 120_000, 15, 2),
    taskPrompt:
      "Draft a changelog from local git history:\n" +
      "1. Run `git log --oneline --no-decorate -30` to see recent commits.\n" +
      "2. Run `git diff --stat HEAD~10..HEAD` to see what files changed recently.\n" +
      "3. Categorise changes into: Features, Fixes, Refactors, Documentation, Chores.\n" +
      "4. Draft a human-readable changelog entry for the period since the last run.\n" +
      "Do not publish changes, create releases, or call external APIs.",
  });
}

function expandPrBabysitter(): LoopConfig {
  return createPreset({
    sourcePreset: "pr_babysitter",
    title: "PR Babysitter",
    description: "PR watch/status/comment template with optional fix Goal handoff for small follow-ups.",
    runKind: "session",
    mode: "report",
    toolProfileId: "loop_github_pr_watch",
    limits: presetBudget(12, 160_000, 20, 4),
    taskPrompt:
      "Watch pull requests and prepare a concise status report:\n" +
      "1. List or inspect the configured PRs and collect current checks, review comments, and open questions.\n" +
      "2. Summarise status, blockers, and requested follow-ups for the architect.\n" +
      "3. Draft a short issue comment only when a clear status update is useful and normal permissions allow it.\n" +
      "4. If a small scoped repair is needed, propose an optional fix Goal instead of changing repository state from this report run.",
  });
}

function expandCiSweeper(): LoopConfig {
  return createPreset({
    sourcePreset: "ci_sweeper",
    title: "CI Sweeper",
    description: "CI watch template: inspect workflow runs, summarise failures, and suggest the next safe action.",
    runKind: "session",
    mode: "report",
    toolProfileId: "loop_ci_watch",
    limits: presetBudget(16, 200_000, 30, 4),
    taskPrompt:
      "Watch CI and summarise action items:\n" +
      "1. Inspect recent workflow runs and failing jobs for the configured repository context.\n" +
      "2. Summarise failure groups with log excerpts, likely owners, and suggested next checks.\n" +
      "3. Rerun a workflow only when the existing tool permission flow explicitly allows that action.\n" +
      "4. Do not change source files in this watch template.",
  });
}

function expandDependencySweeper(): LoopConfig {
  return createPreset({
    sourcePreset: "dependency_sweeper",
    title: "Dependency Sweeper",
    description: "Goal template for dependency maintenance: inspect manifests, choose a scoped update or report, verify, and record evidence.",
    runKind: "goal",
    mode: "act",
    approvalPolicy: "explicit_per_run",
    toolProfileId: "loop_goal_action",
    limits: presetBudget(20, 240_000, 45, 2),
    goalTemplate: dependencySweeperGoalTemplate(),
  });
}

function expandPostLandCleanup(): LoopConfig {
  return createPreset({
    sourcePreset: "post_merge_cleanup",
    title: "Post-Land Cleanup",
    description: "After-land report/action-light template: summarise leftover branch references, linked issues, and follow-up comments.",
    runKind: "session",
    mode: "report",
    toolProfileId: "loop_github_pr_watch",
    limits: presetBudget(10, 140_000, 20, 3),
    taskPrompt:
      "Prepare an after-land cleanup report:\n" +
      "1. Inspect the relevant PR, linked issues, checks, and comments.\n" +
      "2. Summarise leftover follow-ups, stale references, and documentation notes.\n" +
      "3. Draft a concise issue comment only when it helps communicate cleanup status and normal permissions allow it.\n" +
      "4. Keep this run report-oriented and do not perform broad repository-changing actions.",
  });
}

function expandIssueTriage(): LoopConfig {
  return createPreset({
    sourcePreset: "issue_triage",
    title: "Issue Triage",
    description: "Issue tracker triage report: inspect open issues, identify duplicates or stale items, and suggest labels or priorities.",
    runKind: "session",
    mode: "report",
    toolProfileId: "loop_github_pr_watch",
    limits: presetBudget(10, 140_000, 20, 3),
    taskPrompt:
      "Run issue triage:\n" +
      "1. Inspect open or configured issues and gather recent comments.\n" +
      "2. Group likely duplicates, stale reports, missing reproduction details, and priority candidates.\n" +
      "3. Suggest labels, owners, and next questions in a report.\n" +
      "4. Draft a comment only when a clear clarification request is useful and normal permissions allow it.",
  });
}

interface PresetInput {
  readonly sourcePreset: LoopPresetId;
  readonly title: string;
  readonly description: string;
  readonly runKind: LoopConfig["runKind"];
  readonly mode: LoopConfig["mode"];
  readonly approvalPolicy?: LoopConfig["approvalPolicy"];
  readonly toolProfileId: NonNullable<LoopConfig["toolProfileId"]>;
  readonly limits: LoopBudgetConfig;
  readonly taskPrompt?: string;
  readonly instructions?: string;
  readonly goalTemplate?: LoopGoalTemplate;
}

function createPreset(input: PresetInput): LoopConfig {
  return {
    title: input.title,
    description: input.description,
    schedule: { kind: "manual" },
    runKind: input.runKind,
    mode: input.mode,
    approvalPolicy: input.approvalPolicy ?? (input.mode === "act" ? "explicit_per_run" : "interactive"),
    limits: input.limits,
    toolProfileId: input.toolProfileId,
    ...(input.taskPrompt === undefined ? {} : { taskPrompt: input.taskPrompt }),
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    ...(input.goalTemplate === undefined ? {} : { goalTemplate: input.goalTemplate }),
    sourcePreset: input.sourcePreset,
  };
}

function presetBudget(
  maxIterationsPerRun: number,
  maxTokensPerRun: number,
  maxWallClockMinutesPerRun: number,
  maxRunsPerDay: number,
): LoopBudgetConfig {
  // Preset expansion has no model pricing metadata. Leaving USD absent keeps
  // the USD guard unavailable instead of treating missing pricing as zero cost.
  return {
    maxIterationsPerRun,
    maxTokensPerRun,
    maxWallClockMsPerRun: maxWallClockMinutesPerRun * MINUTE_MS,
    maxRunsPerDay,
    softThresholdRatio: 0.8,
    hardThresholdRatio: 1.0,
  };
}

function dependencySweeperGoalTemplate(): LoopGoalTemplate {
  return {
    title: "Dependency Sweeper Goal",
    objective:
      "Inspect dependency manifests and lockfiles, identify one scoped dependency maintenance action or a report-only outcome, " +
      "make only the local changes needed for that action, and ask Reviewer to judge the result from the session logs, diff, and verification output.",
    acceptanceCriteria:
      "The Goal is acceptable when Reviewer can see that dependency changes, if any, are narrowly scoped, repository health checks relevant to the change were run through normal tools, " +
      "and the final review receipt explains the outcome with evidence references from ordinary session output.",
  };
}
