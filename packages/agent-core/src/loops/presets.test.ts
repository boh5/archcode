import { describe, expect, test } from "bun:test";

import { LoopConfigSchema } from "./state";
import {
  LOOP_PRESET_IDS,
  SUPPORTED_LOOP_PRESET_IDS,
  expandLoopPreset,
  getUnsupportedLoopPresetReason,
  isSupportedLoopPreset,
} from "./presets";

describe("isSupportedLoopPreset", () => {
  test("returns true for daily_triage", () => {
    expect(isSupportedLoopPreset("daily_triage")).toBe(true);
  });

  test("returns true for changelog_drafter", () => {
    expect(isSupportedLoopPreset("changelog_drafter")).toBe(true);
  });

  test("returns false for connector-dependent presets", () => {
    expect(isSupportedLoopPreset("pr_babysitter")).toBe(false);
    expect(isSupportedLoopPreset("ci_sweeper")).toBe(false);
    expect(isSupportedLoopPreset("dependency_sweeper")).toBe(false);
    expect(isSupportedLoopPreset("post_merge_cleanup")).toBe(false);
    expect(isSupportedLoopPreset("issue_triage")).toBe(false);
  });

  test("returns false for unknown ids", () => {
    expect(isSupportedLoopPreset("unknown")).toBe(false);
    expect(isSupportedLoopPreset("")).toBe(false);
  });
});

describe("getUnsupportedLoopPresetReason", () => {
  test("returns undefined for supported presets", () => {
    expect(getUnsupportedLoopPresetReason("daily_triage")).toBeUndefined();
    expect(getUnsupportedLoopPresetReason("changelog_drafter")).toBeUndefined();
  });

  test("returns a reason string for connector-dependent presets", () => {
    expect(getUnsupportedLoopPresetReason("pr_babysitter")).toBeTruthy();
    expect(getUnsupportedLoopPresetReason("ci_sweeper")).toBeTruthy();
    expect(getUnsupportedLoopPresetReason("dependency_sweeper")).toBeTruthy();
    expect(getUnsupportedLoopPresetReason("post_merge_cleanup")).toBeTruthy();
    expect(getUnsupportedLoopPresetReason("issue_triage")).toBeTruthy();
  });

  test("returns undefined for unknown ids", () => {
    expect(getUnsupportedLoopPresetReason("unknown")).toBeUndefined();
  });

  test("each unsupported reason mentions the missing connector", () => {
    expect(getUnsupportedLoopPresetReason("pr_babysitter")).toMatch(/GitHub/i);
    expect(getUnsupportedLoopPresetReason("ci_sweeper")).toMatch(/CI/i);
    expect(getUnsupportedLoopPresetReason("dependency_sweeper")).toMatch(/CI/i);
    expect(getUnsupportedLoopPresetReason("post_merge_cleanup")).toMatch(/GitHub/i);
    expect(getUnsupportedLoopPresetReason("issue_triage")).toMatch(/GitHub/i);
  });
});

describe("expandLoopPreset", () => {
  test("daily_triage expands to a valid LoopConfig with sourcePreset metadata", () => {
    const config = expandLoopPreset("daily_triage");
    const parsed = LoopConfigSchema.parse(config);
    expect(parsed.title).toBe("Daily Triage");
    expect(parsed.sourcePreset).toBe("daily_triage");
    expect(parsed.schedule).toEqual({ kind: "manual" });
    expect(parsed.runKind).toBe("session");
    expect(parsed.mode).toBe("report");
    expect(parsed.approvalPolicy).toBe("interactive");
    expect(parsed.limits).toEqual({ maxIterationsPerRun: 8 });
  });

  test("changelog_drafter expands to a valid LoopConfig with sourcePreset metadata", () => {
    const config = expandLoopPreset("changelog_drafter");
    const parsed = LoopConfigSchema.parse(config);
    expect(parsed.title).toBe("Changelog Drafter");
    expect(parsed.sourcePreset).toBe("changelog_drafter");
    expect(parsed.schedule).toEqual({ kind: "manual" });
    expect(parsed.runKind).toBe("session");
    expect(parsed.mode).toBe("report");
    expect(parsed.approvalPolicy).toBe("interactive");
    expect(parsed.limits).toEqual({ maxIterationsPerRun: 8 });
  });

  test("daily_triage taskPrompt is local-only (no external API dependency)", () => {
    const config = expandLoopPreset("daily_triage");
    const prompt = config.taskPrompt ?? "";
    expect(prompt).toMatch(/git status/);
    expect(prompt).toMatch(/TODO|FIXME/);
    expect(prompt).toMatch(/typecheck|test/);
    expect(prompt).not.toMatch(/GitHub|Slack|Linear|CI|release/i);
  });

  test("changelog_drafter taskPrompt is local-only (no external API dependency)", () => {
    const config = expandLoopPreset("changelog_drafter");
    const prompt = config.taskPrompt ?? "";
    expect(prompt).toMatch(/git log/);
    expect(prompt).toMatch(/changelog/);
    expect(prompt).not.toMatch(/GitHub|Slack|Linear|CI/i);
  });

  test("rejects connector-dependent presets with RangeError", () => {
    for (const id of ["pr_babysitter", "ci_sweeper", "dependency_sweeper", "post_merge_cleanup", "issue_triage"] as const) {
      expect(() => expandLoopPreset(id)).toThrow(RangeError);
      expect(() => expandLoopPreset(id)).toThrow(/unsupported/i);
    }
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

  test("SUPPORTED_LOOP_PRESET_IDS contains exactly the 2 local presets", () => {
    expect(SUPPORTED_LOOP_PRESET_IDS).toEqual(["daily_triage", "changelog_drafter"]);
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
