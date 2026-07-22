import { describe, expect, test } from "bun:test";

import { sessionGoalControlVisibility, sessionGoalMutationError } from "./SessionGoalProgressRow";

describe("SessionGoalProgressRow controls", () => {
  test("keeps complete Goals clearable but immutable", () => {
    expect(sessionGoalControlVisibility("complete")).toEqual({
      edit: false,
      pause: false,
      resume: false,
      clear: true,
    });
  });

  test("returns the exact five-state control matrix", () => {
    expect(sessionGoalControlVisibility("active")).toEqual({ edit: true, pause: true, resume: false, clear: true });
    expect(sessionGoalControlVisibility("paused")).toEqual({ edit: true, pause: false, resume: true, clear: true });
    expect(sessionGoalControlVisibility("blocked")).toEqual({ edit: true, pause: false, resume: true, clear: true });
    expect(sessionGoalControlVisibility("budget_limited")).toEqual({ edit: true, pause: false, resume: false, clear: true });
  });

  test("surfaces the actionable API error instead of hiding it behind generic copy", () => {
    expect(sessionGoalMutationError(undefined, new Error("Increase the token budget before resuming")))
      .toBe("Increase the token budget before resuming");
    expect(sessionGoalMutationError(undefined, { status: 422 })).toBe("Unable to update this goal.");
    expect(sessionGoalMutationError(undefined, null)).toBeUndefined();
  });
});
