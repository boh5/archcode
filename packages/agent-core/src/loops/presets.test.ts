import { describe, expect, test } from "bun:test";

import { LoopConfigSchema } from "./state";
import {
  LOOP_PRESET_IDS,
  SUPPORTED_LOOP_PRESET_IDS,
  expandLoopPreset,
  getUnsupportedLoopPresetReason,
  isSupportedLoopPreset,
  type LoopPresetId,
} from "./presets";

const MINUTE_MS = 60_000;

const EXPECTED_PRESETS = {
  daily_triage: {
    title: "Daily Triage",
    runKind: "session",
    mode: "report",
    toolProfileId: "loop_local_report",
    limits: {
      maxIterationsPerRun: 8,
      maxTokensPerRun: 120_000,
      maxWallClockMsPerRun: 15 * MINUTE_MS,
      maxRunsPerDay: 2,
      softThresholdRatio: 0.8,
      hardThresholdRatio: 1.0,
    },
  },
  changelog_drafter: {
    title: "Changelog Drafter",
    runKind: "session",
    mode: "report",
    toolProfileId: "loop_local_report",
    limits: {
      maxIterationsPerRun: 8,
      maxTokensPerRun: 120_000,
      maxWallClockMsPerRun: 15 * MINUTE_MS,
      maxRunsPerDay: 2,
      softThresholdRatio: 0.8,
      hardThresholdRatio: 1.0,
    },
  },
  pr_babysitter: {
    title: "PR Babysitter",
    runKind: "session",
    mode: "report",
    toolProfileId: "loop_github_pr_watch",
    limits: {
      maxIterationsPerRun: 12,
      maxTokensPerRun: 160_000,
      maxWallClockMsPerRun: 20 * MINUTE_MS,
      maxRunsPerDay: 4,
      softThresholdRatio: 0.8,
      hardThresholdRatio: 1.0,
    },
  },
  ci_sweeper: {
    title: "CI Sweeper",
    runKind: "session",
    mode: "report",
    toolProfileId: "loop_ci_watch",
    limits: {
      maxIterationsPerRun: 16,
      maxTokensPerRun: 200_000,
      maxWallClockMsPerRun: 30 * MINUTE_MS,
      maxRunsPerDay: 4,
      softThresholdRatio: 0.8,
      hardThresholdRatio: 1.0,
    },
  },
  dependency_sweeper: {
    title: "Dependency Sweeper",
    runKind: "goal",
    mode: "act",
    toolProfileId: "loop_goal_action",
    limits: {
      maxIterationsPerRun: 20,
      maxTokensPerRun: 240_000,
      maxWallClockMsPerRun: 45 * MINUTE_MS,
      maxRunsPerDay: 2,
      softThresholdRatio: 0.8,
      hardThresholdRatio: 1.0,
    },
  },
  post_merge_cleanup: {
    title: "Post-Land Cleanup",
    runKind: "session",
    mode: "report",
    toolProfileId: "loop_github_pr_watch",
    limits: {
      maxIterationsPerRun: 10,
      maxTokensPerRun: 140_000,
      maxWallClockMsPerRun: 20 * MINUTE_MS,
      maxRunsPerDay: 3,
      softThresholdRatio: 0.8,
      hardThresholdRatio: 1.0,
    },
  },
  issue_triage: {
    title: "Issue Triage",
    runKind: "session",
    mode: "report",
    toolProfileId: "loop_github_pr_watch",
    limits: {
      maxIterationsPerRun: 10,
      maxTokensPerRun: 140_000,
      maxWallClockMsPerRun: 20 * MINUTE_MS,
      maxRunsPerDay: 3,
      softThresholdRatio: 0.8,
      hardThresholdRatio: 1.0,
    },
  },
} as const satisfies Record<LoopPresetId, {
  title: string;
  runKind: "session" | "goal";
  mode: "report" | "act";
  toolProfileId: string;
  limits: {
    maxIterationsPerRun: number;
    maxTokensPerRun: number;
    maxWallClockMsPerRun: number;
    maxRunsPerDay: number;
    softThresholdRatio: number;
    hardThresholdRatio: number;
  };
}>;

describe("isSupportedLoopPreset", () => {
  test("returns true for every editable preset template", () => {
    for (const id of LOOP_PRESET_IDS) {
      expect(isSupportedLoopPreset(id)).toBe(true);
    }
  });

  test("returns false for unknown ids", () => {
    expect(isSupportedLoopPreset("unknown")).toBe(false);
    expect(isSupportedLoopPreset("")).toBe(false);
  });
});

describe("getUnsupportedLoopPresetReason", () => {
  test("returns undefined for all editable preset templates", () => {
    for (const id of LOOP_PRESET_IDS) {
      expect(getUnsupportedLoopPresetReason(id)).toBeUndefined();
    }
  });

  test("returns undefined for unknown ids", () => {
    expect(getUnsupportedLoopPresetReason("unknown")).toBeUndefined();
  });
});

describe("expandLoopPreset", () => {
  test("all preset ids expand to valid editable LoopConfig templates", () => {
    for (const id of LOOP_PRESET_IDS) {
      const config = expandLoopPreset(id);
      const parsed = LoopConfigSchema.parse(config);
      const expected = EXPECTED_PRESETS[id];

      expect(parsed.title).toBe(expected.title);
      expect(parsed.sourcePreset).toBe(id);
      expect(parsed.schedule).toEqual({ kind: "manual" });
      expect(parsed.runKind).toBe(expected.runKind);
      expect(parsed.mode).toBe(expected.mode);
      expect(parsed.approvalPolicy).toBe(expected.mode === "act" ? "explicit_per_run" : "interactive");
      expect(parsed.toolProfileId).toBe(expected.toolProfileId);
      expect(parsed.limits).toEqual(expected.limits);
      expect(parsed.budget).toBeUndefined();
      expect(parsed.taskPrompt ?? parsed.goalTemplate?.objective ?? "").not.toHaveLength(0);
    }
  });

  test("conservative budget defaults are editable and omit USD guard when pricing is absent", () => {
    for (const id of LOOP_PRESET_IDS) {
      const config = expandLoopPreset(id);
      const parsed = LoopConfigSchema.parse(config);
      const limits = parsed.limits as ExpandedPresetLimits;

      expect(Object.hasOwn(limits, "maxEstimatedUsdPerRun")).toBe(false);
      expect(limits.maxEstimatedUsdPerRun).toBeUndefined();

      const edited = LoopConfigSchema.parse({
        ...parsed,
        limits: {
          ...limits,
          maxIterationsPerRun: limits.maxIterationsPerRun + 1,
          maxTokensPerRun: limits.maxTokensPerRun + 1_000,
        },
      });
      const editedLimits = edited.limits as ExpandedPresetLimits;
      expect(editedLimits.maxIterationsPerRun).toBe(limits.maxIterationsPerRun + 1);
      expect(editedLimits.maxTokensPerRun).toBe(limits.maxTokensPerRun + 1_000);
      expect(editedLimits.maxEstimatedUsdPerRun).toBeUndefined();
    }
  });

  test("PR Babysitter copy is watch/status/comment/optional-fix only", () => {
    const config = expandLoopPreset("pr_babysitter");
    const text = presetText(config);

    expect(text).toMatch(/watch/i);
    expect(text).toMatch(/status|checks/i);
    expect(text).toMatch(/comment/i);
    expect(text).toMatch(/optional fix goal/i);
    expect(text).not.toMatch(/merge babysitting|approve PR|rebase|force push|force-push/i);
  });

  test("no preset text includes forbidden default behavior", () => {
    for (const id of LOOP_PRESET_IDS) {
      expect(presetText(expandLoopPreset(id))).not.toMatch(/merge babysitting|approve PR|rebase|force push|force-push/i);
    }
  });

  test("goal presets include inline goal templates and session presets do not require one", () => {
    for (const id of LOOP_PRESET_IDS) {
      const parsed = LoopConfigSchema.parse(expandLoopPreset(id));
      if (parsed.runKind === "goal") {
        expect(parsed.goalTemplate).toBeDefined();
        expect(parsed.goalTemplate?.title).toBe("Dependency Sweeper Goal");
        expect(parsed.goalTemplate?.objective).toContain("dependency maintenance");
        expect(parsed.goalTemplate?.acceptanceCriteria).toContain("Reviewer");
        continue;
      }

      expect(parsed.goalTemplate).toBeUndefined();
    }
  });

  test("stored runKind and toolProfileId remain editable template data", () => {
    const preset = LoopConfigSchema.parse(expandLoopPreset("pr_babysitter"));
    const edited = LoopConfigSchema.parse({
      ...preset,
      runKind: "goal",
      mode: "act",
      approvalPolicy: "explicit_per_run",
      toolProfileId: "loop_goal_action",
      goalTemplate: {
        title: "Edited PR follow-up Goal",
        objective: "Run the edited follow-up Goal from the stored LoopConfig values.",
        acceptanceCriteria: "Reviewer can determine DONE from logs and evidence refs without typed acceptance arrays.",
      },
    });

    expect(edited.sourcePreset).toBe("pr_babysitter");
    expect(edited.runKind).toBe("goal");
    expect(edited.toolProfileId).toBe("loop_goal_action");
    expect(() => LoopConfigSchema.parse({ ...preset, toolProfileId: "github_merge_pull_request" })).toThrow();
  });

  test("rejects unknown preset ids with RangeError", () => {
    expect(() => expandLoopPreset("unknown")).toThrow(RangeError);
    expect(() => expandLoopPreset("")).toThrow(RangeError);
    expect(() => expandLoopPreset("daily-triage")).toThrow(RangeError);
  });
});

describe("preset id constants", () => {
  test("LOOP_PRESET_IDS contains all 7 presets", () => {
    expect(LOOP_PRESET_IDS).toEqual([
      "daily_triage",
      "changelog_drafter",
      "pr_babysitter",
      "ci_sweeper",
      "dependency_sweeper",
      "post_merge_cleanup",
      "issue_triage",
    ]);
  });

  test("SUPPORTED_LOOP_PRESET_IDS contains every editable template", () => {
    expect(SUPPORTED_LOOP_PRESET_IDS).toEqual(LOOP_PRESET_IDS);
  });

  test("supported ids are a subset of all ids", () => {
    for (const id of SUPPORTED_LOOP_PRESET_IDS) {
      expect(LOOP_PRESET_IDS).toContain(id);
    }
  });
});

describe("runtime does not branch on sourcePreset", () => {
  test("runtime files (excluding presets/state/index/test) must not reference sourcePreset or preset IDs", async () => {
    // Preset IDs are create-time metadata only. Runtime execution files
    // (scheduler, runner, etc.) must not switch on sourcePreset or
    // concrete preset ID strings. This test scans all non-exempt .ts files
    // in the loops directory and fails if any violate this constraint.
    const glob = new Bun.Glob("*.ts");
    const files: string[] = [];
    for await (const file of glob.scan({ cwd: import.meta.dir, absolute: false })) {
      files.push(file);
    }

    // Exempted files:
    //   *.test.ts       — test files are allowed to reference presets
    //   index.ts         — barrel export, no branching logic
    //   presets.ts       — owns preset definitions, naturally contains all IDs
    //   state.ts         — schema definition, contains sourcePreset as optional field
    const exempted = new Set([
      "index.ts",
      "presets.ts",
      "state.ts",
    ]);
    const runtimeFiles = files.filter(
      (f) => !f.endsWith(".test.ts") && !exempted.has(f),
    );

    // Build regex from the authoritative preset ID list
    const presetIdPattern = LOOP_PRESET_IDS.map((id) =>
      // Match the preset ID as a quoted string literal
      `["'\`]${escapeRegex(id)}["'\`]`,
    ).join("|");

    const sourcePresetPattern = "sourcePreset";
    const forbiddenPattern = new RegExp(`${sourcePresetPattern}|${presetIdPattern}`);

    for (const file of runtimeFiles) {
      const content = await Bun.file(new URL(file, import.meta.url)).text();
      expect(content).not.toMatch(forbiddenPattern);
    }
  });
});

function presetText(config: ReturnType<typeof expandLoopPreset>): string {
  return [
    config.title,
    config.description,
    config.taskPrompt,
    config.instructions,
    config.goalTemplate?.title,
    config.goalTemplate?.objective,
    config.goalTemplate?.acceptanceCriteria,
  ].filter((value): value is string => value !== undefined).join("\n");
}

type ExpandedPresetLimits = {
  maxIterationsPerRun: number;
  maxTokensPerRun: number;
  maxEstimatedUsdPerRun?: number;
  maxWallClockMsPerRun: number;
  maxRunsPerDay: number;
  softThresholdRatio: number;
  hardThresholdRatio: number;
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
