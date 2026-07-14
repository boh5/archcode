import { describe, expect, test } from "bun:test";
import type { GoalStatus } from "@archcode/protocol";
import { getGoalStatusBadgeClass, GOAL_STATUS_BADGE_CLASSES } from "./goal-status";

const statuses: GoalStatus[] = ["running", "reviewing", "done", "not_done", "failed", "cancelled"];

describe("Goal status badge classes", () => {
  test("defines one class mapping for every Goal status", () => {
    expect(Object.keys(GOAL_STATUS_BADGE_CLASSES).sort()).toEqual([...statuses].sort());
  });

  test("preserves the existing badge classes", () => {
    expect(GOAL_STATUS_BADGE_CLASSES).toEqual({
      running: "bg-success-muted text-success",
      reviewing: "bg-info-muted text-info",
      done: "bg-accent-muted text-accent",
      not_done: "bg-error-muted text-error",
      failed: "bg-error-muted text-error",
      cancelled: "bg-bg-active text-text-muted",
    });
  });

  test("getter resolves the canonical mapping", () => {
    for (const status of statuses) {
      expect(getGoalStatusBadgeClass(status)).toBe(GOAL_STATUS_BADGE_CLASSES[status]);
    }
  });
});
