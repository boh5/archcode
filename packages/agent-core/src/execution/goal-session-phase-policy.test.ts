import { describe, expect, test } from "bun:test";

import { decideGoalSessionExecution, isGoalDelegationAllowed } from "./goal-session-phase-policy";

const main = {
  sessionId: "main",
  rootSessionId: "main",
  agentName: "goal_lead" as const,
  sessionRole: "main" as const,
};
const reviewer = {
  sessionId: "review",
  rootSessionId: "main",
  parentSessionId: "main",
  isDescendantOfRoot: true,
  agentName: "reviewer" as const,
  sessionRole: "review" as const,
};
const reviewerExplore = {
  sessionId: "review-explore",
  rootSessionId: "main",
  parentSessionId: "review",
  parentAgentName: "reviewer" as const,
  isDescendantOfRoot: true,
  agentName: "explore" as const,
  sessionRole: "explore" as const,
};

describe("Goal Session phase policy", () => {
  test("keeps execution and delegation on one role matrix", () => {
    const reviewing = { status: "reviewing" as const, mainSessionId: "main" };
    expect(decideGoalSessionExecution({ goal: reviewing, subject: main, entryKind: "user_message" })).toEqual({ allowed: true });
    expect(decideGoalSessionExecution({ goal: reviewing, subject: reviewer, entryKind: "user_message" })).toEqual({ allowed: true });
    expect(decideGoalSessionExecution({ goal: reviewing, subject: reviewerExplore, entryKind: "user_message" })).toEqual({ allowed: true });
    expect(decideGoalSessionExecution({ goal: reviewing, subject: { ...reviewerExplore, parentAgentName: "plan" }, entryKind: "user_message" })).toEqual({ allowed: false, reason: "reviewer_required" });
    expect(isGoalDelegationAllowed({ goal: reviewing, parent: main, targetAgentName: "reviewer" })).toBe(true);
    expect(isGoalDelegationAllowed({ goal: reviewing, parent: main, targetAgentName: "build" })).toBe(false);
    expect(isGoalDelegationAllowed({ goal: reviewing, parent: reviewer, targetAgentName: "explore" })).toBe(true);
  });

  test("requires proven ancestry and keeps not_done on the Goal Lead", () => {
    const running = { status: "running" as const, mainSessionId: "main" };
    const forged = { ...reviewer, isDescendantOfRoot: false };
    expect(decideGoalSessionExecution({ goal: running, subject: forged, entryKind: "user_message" })).toEqual({ allowed: false, reason: "not_executable" });
    expect(isGoalDelegationAllowed({ goal: running, parent: forged, targetAgentName: "explore" })).toBe(false);
    expect(decideGoalSessionExecution({ goal: running, subject: reviewer, entryKind: "user_message" })).toEqual({ allowed: false, reason: "not_executable" });
    expect(isGoalDelegationAllowed({ goal: running, parent: main, targetAgentName: "reviewer" })).toBe(false);

    const notDone = { status: "not_done" as const, mainSessionId: "main" };
    expect(decideGoalSessionExecution({ goal: notDone, subject: main, entryKind: "user_message" })).toEqual({ allowed: true });
    expect(decideGoalSessionExecution({ goal: notDone, subject: reviewer, entryKind: "user_message" })).toEqual({ allowed: false, reason: "not_executable" });
    expect(isGoalDelegationAllowed({ goal: notDone, parent: main, targetAgentName: "build" })).toBe(false);
  });
});
