import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { GoalPhase } from "@archcode/protocol";

import {
  CANONICAL_ARTIFACT_NAMES,
  GoalArtifactManager,
  GoalArtifactNameError,
  GoalArtifactPathError,
  GoalArtifactPlanLockedError,
  GoalArtifactSecretError,
  type GoalArtifactOwner,
} from "./artifacts";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "goal-artifacts");
const GOAL_ID = "550e8400-e29b-41d4-a716-446655440000";

function goal(phase: GoalPhase): GoalArtifactOwner {
  return { id: GOAL_ID, phase };
}

async function captureAsyncError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected async action to throw");
}

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("GoalArtifactManager", () => {
  test("writes, reads, and lists canonical markdown artifacts only", async () => {
    const manager = new GoalArtifactManager(TMP_DIR);

    const written = await manager.writeArtifact(goal("build"), "build.md", "# Build\n\nDone", {
      agentName: "build",
    });

    expect(written).toMatchObject({
      name: "build.md",
      path: join(".archcode", "goals", GOAL_ID, "artifacts", "build.md"),
      mediaType: "text/markdown",
      sizeBytes: "# Build\n\nDone\n".length,
    });
    expect(written.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(written.updatedAt ?? "")).not.toBeNaN();
    expect(await manager.readArtifact(GOAL_ID, "build.md")).toBe("# Build\n\nDone\n");
    expect(await manager.listArtifacts(GOAL_ID)).toEqual([written]);
    expect(CANONICAL_ARTIFACT_NAMES).toEqual([
      "plan.md",
      "build.md",
      "review.md",
      "spec-compliance.md",
      "approvals.md",
      "budget.md",
      "retry-log.md",
      "final-report.md",
    ]);
  });

  test("rejects traversal, non-canonical names, version files, revision directories, and latest pointers", async () => {
    const manager = new GoalArtifactManager(TMP_DIR);
    const invalidNames = [
      "../goal.json",
      "plan-v2.md",
      "revisions/plan.md",
      "latest.json",
      "latest",
    ];

    for (const name of invalidNames) {
      const error = await captureAsyncError(() => manager.resolveArtifactPathForTest(GOAL_ID, name));
      expect(error).toBeInstanceOf(GoalArtifactNameError);
    }

    const traversalGoalError = await captureAsyncError(() => manager.readArtifact("../goal.json", "build.md"));
    expect(traversalGoalError).toBeInstanceOf(GoalArtifactPathError);

    const goalDir = join(TMP_DIR, ".archcode", "goals", GOAL_ID);
    expect(existsSync(join(goalDir, "goal.json"))).toBe(false);
    expect(existsSync(join(goalDir, "artifacts", "plan-v2.md"))).toBe(false);
    expect(existsSync(join(goalDir, "artifacts", "revisions"))).toBe(false);
    expect(existsSync(join(goalDir, "artifacts", "latest.json"))).toBe(false);
  });

  test("atomic writes replace current files without versions or temp files", async () => {
    const manager = new GoalArtifactManager(TMP_DIR);

    await manager.writeArtifact(goal("build"), "review.md", "first", { agentName: "reviewer" });
    await manager.writeArtifact(goal("build"), "review.md", "second", { agentName: "reviewer" });

    const artifactDir = join(TMP_DIR, ".archcode", "goals", GOAL_ID, "artifacts");
    expect(await Bun.file(join(artifactDir, "review.md")).text()).toBe("second\n");
    expect((await readdir(artifactDir)).sort()).toEqual(["review.md"]);
    expect((await readdir(artifactDir)).some((entry) => entry.startsWith(".tmp-"))).toBe(false);
    expect(existsSync(join(artifactDir, "versions"))).toBe(false);
    expect(existsSync(join(artifactDir, "revisions"))).toBe(false);
    expect(existsSync(join(artifactDir, "latest"))).toBe(false);
  });

  test("plan.md can only be written by Plan Agent during plan phase", async () => {
    const manager = new GoalArtifactManager(TMP_DIR);

    const written = await manager.writeArtifact(goal("plan"), "plan.md", "# Plan", { agentName: "plan" });
    expect(written).toMatchObject({
      name: "plan.md",
    });

    const wrongAgentError = await captureAsyncError(() => {
      return manager.writeArtifact(goal("plan"), "plan.md", "# Plan", { agentName: "build" });
    });
    expect(wrongAgentError).toBeInstanceOf(GoalArtifactPlanLockedError);

    const lockedError = await captureAsyncError(() => {
      return manager.writeArtifact(goal("build"), "plan.md", "# Plan", { agentName: "plan" });
    });
    expect(lockedError).toBeInstanceOf(GoalArtifactPlanLockedError);
    expect(await manager.readArtifact(GOAL_ID, "plan.md")).toBe("# Plan\n");
  });

  test("rejects secrets before writing agent content", async () => {
    const manager = new GoalArtifactManager(TMP_DIR);

    const error = await captureAsyncError(() => {
      return manager.writeArtifact(goal("build"), "build.md", "api_key=sk_test_12345678", {
        agentName: "build",
      });
    });

    expect(error).toBeInstanceOf(GoalArtifactSecretError);
    expect(existsSync(join(TMP_DIR, ".archcode", "goals", GOAL_ID, "artifacts", "build.md"))).toBe(false);
  });

  test("returns null and empty list for missing current artifacts", async () => {
    const manager = new GoalArtifactManager(TMP_DIR);

    expect(await manager.readArtifact(GOAL_ID, "final-report.md")).toBeNull();
    expect(await manager.listArtifacts(GOAL_ID)).toEqual([]);
  });
});
