import { describe, expect, test } from "bun:test";

import { sessionGoalControlVisibility, sessionGoalMutationError } from "./SessionGoalProgressRow";

describe("SessionGoalProgressRow controls", () => {
  test("keeps complete Goals clearable but immutable", () => {
    expect(sessionGoalControlVisibility("complete")).toEqual({
      edit: false,
      pause: false,
      resume: false,
      adjustBudget: false,
      clear: true,
    });
  });

  test("exposes exactly the recovery control for each non-terminal stopped state", () => {
    expect(sessionGoalControlVisibility("paused")).toMatchObject({ resume: true, adjustBudget: false, clear: true });
    expect(sessionGoalControlVisibility("blocked")).toMatchObject({ resume: true, adjustBudget: false, clear: true });
    expect(sessionGoalControlVisibility("budget_limited")).toMatchObject({ resume: false, adjustBudget: true, clear: true });
  });

  test("surfaces the actionable API error instead of hiding it behind generic copy", () => {
    expect(sessionGoalMutationError(undefined, new Error("Increase the token budget before resuming")))
      .toBe("Increase the token budget before resuming");
    expect(sessionGoalMutationError(undefined, { status: 422 })).toBe("Unable to update this goal.");
    expect(sessionGoalMutationError(undefined, null)).toBeUndefined();
  });
});
