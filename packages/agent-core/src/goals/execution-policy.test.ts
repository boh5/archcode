import { describe, expect, test } from "bun:test";
import type { GoalStatus } from "@archcode/protocol";

import { goalExecutionStatusEligibility } from "./execution-policy";

const STATUSES: readonly GoalStatus[] = [
  "draft",
  "running",
  "blocked",
  "reviewing",
  "done",
  "not_done",
  "failed",
  "cancelled",
];

describe("Goal execution policy", () => {
  test("allows start only from draft and classifies running as an existing claim", () => {
    expect(Object.fromEntries(STATUSES.map((status) => [status, goalExecutionStatusEligibility("start", status)]))).toEqual({
      draft: "proceed",
      running: "running_claim",
      blocked: "reject",
      reviewing: "reject",
      done: "reject",
      not_done: "reject",
      failed: "reject",
      cancelled: "reject",
    });
  });

  test("allows retry only from not_done or failed and classifies running as an existing claim", () => {
    expect(Object.fromEntries(STATUSES.map((status) => [status, goalExecutionStatusEligibility("retry", status)]))).toEqual({
      draft: "reject",
      running: "running_claim",
      blocked: "reject",
      reviewing: "reject",
      done: "reject",
      not_done: "proceed",
      failed: "proceed",
      cancelled: "reject",
    });
  });
});
