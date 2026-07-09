import { describe, expect, test } from "bun:test";
import type { LoopRunReport, LoopStatus } from "../api/types";
import {
  deriveLoopDisplayState,
  deriveLoopStatus,
  formatLoopActivity,
  formatRunHistoryBadgeClass,
  formatRunHistoryLabel,
  type LoopStatusInput,
} from "./loop-status";

function makeRun(overrides: Partial<LoopRunReport> = {}): LoopRunReport {
  return {
    runId: "run-1",
    loopId: "loop-1",
    status: "running",
    trigger: "manual",
    startedAt: 1700000000000,
    ...overrides,
  };
}

function makeInput(overrides: Partial<LoopStatusInput> = {}): LoopStatusInput {
  return {
    status: "active" as LoopStatus,
    ...overrides,
  };
}

describe("deriveLoopDisplayState", () => {
  test("currentRun running -> running", () => {
    expect(
      deriveLoopDisplayState(makeInput({ currentRun: makeRun({ status: "running" }) })),
    ).toBe("running");
  });

  test("currentRun needs_user -> waiting_for_input", () => {
    expect(
      deriveLoopDisplayState(makeInput({ currentRun: makeRun({ status: "needs_user" }) })),
    ).toBe("waiting_for_input");
  });

  test("loop status error -> error regardless of lastRun", () => {
    const erroredWithLastRun = {
      ...makeInput({ status: "error" }),
      lastRun: makeRun({ status: "succeeded" }),
    };
    expect(deriveLoopDisplayState(makeInput({ status: "error" }))).toBe("error");
    expect(deriveLoopDisplayState(erroredWithLastRun)).toBe("error");
  });

  test("loop status paused -> paused", () => {
    expect(deriveLoopDisplayState(makeInput({ status: "paused" }))).toBe("paused");
  });

  test("loop status disabled -> disabled", () => {
    expect(deriveLoopDisplayState(makeInput({ status: "disabled" }))).toBe("disabled");
  });

  test("active with no current run -> ready (not Running)", () => {
    expect(deriveLoopDisplayState(makeInput({ status: "active" }))).toBe("ready");
  });

  test("active with finished current run (succeeded) -> ready", () => {
    expect(
      deriveLoopDisplayState(
        makeInput({ status: "active", currentRun: makeRun({ status: "succeeded" }) }),
      ),
    ).toBe("ready");
  });

  test("active with failed current run -> ready (lastRun is history, not current state)", () => {
    const activeWithFailedHistory = {
      ...makeInput({
        status: "active",
        currentRun: makeRun({ status: "failed" }),
      }),
      lastRun: makeRun({ status: "failed" }),
    };

    expect(
      deriveLoopDisplayState(activeWithFailedHistory),
    ).toBe("ready");
  });

  test("paused with running current run -> running (currentRun wins)", () => {
    expect(
      deriveLoopDisplayState(
        makeInput({ status: "paused", currentRun: makeRun({ status: "running" }) }),
      ),
    ).toBe("running");
  });

  test("does not consult lastRun for current state", () => {
    const withFailedLast = {
      ...makeInput({ status: "active" }),
      lastRun: makeRun({ status: "failed" }),
    };
    expect(deriveLoopDisplayState(withFailedLast)).toBe("ready");
  });
});

describe("deriveLoopStatus", () => {
  test("running state has Running label, success badge, activity text, canCancel true", () => {
    const info = deriveLoopStatus(
      makeInput({ currentRun: makeRun({ status: "running", trigger: "interval", sessionId: "s1" }) }),
    );
    expect(info.state).toBe("running");
    expect(info.label).toBe("Running");
    expect(info.badgeClass).toContain("bg-success");
    expect(info.activity).toContain("Running interval run");
    expect(info.activity).toContain("session s1");
    expect(info.canCancel).toBe(true);
  });

  test("waiting_for_input state has Awaiting Input label, warning badge, canCancel false", () => {
    const info = deriveLoopStatus(
      makeInput({ currentRun: makeRun({ status: "needs_user" }) }),
    );
    expect(info.state).toBe("waiting_for_input");
    expect(info.label).toBe("Awaiting Input");
    expect(info.badgeClass).toContain("bg-warning");
    expect(info.activity).toBe("Waiting for user input");
    expect(info.canCancel).toBe(false);
  });

  test("ready state has Ready label, neutral badge, canCancel false", () => {
    const info = deriveLoopStatus(makeInput({ status: "active" }));
    expect(info.state).toBe("ready");
    expect(info.label).toBe("Ready");
    expect(info.badgeClass).toContain("bg-bg-active");
    expect(info.activity).toBe("Ready");
    expect(info.canCancel).toBe(false);
  });

  test("paused state has Paused label", () => {
    const info = deriveLoopStatus(makeInput({ status: "paused" }));
    expect(info.state).toBe("paused");
    expect(info.label).toBe("Paused");
    expect(info.activity).toBe("Paused");
  });

  test("disabled state has Disabled label", () => {
    const info = deriveLoopStatus(makeInput({ status: "disabled" }));
    expect(info.state).toBe("disabled");
    expect(info.label).toBe("Disabled");
    expect(info.activity).toBe("Disabled");
  });

  test("error state has Error label, error badge", () => {
    const info = deriveLoopStatus(makeInput({ status: "error" }));
    expect(info.state).toBe("error");
    expect(info.label).toBe("Error");
    expect(info.badgeClass).toContain("bg-error");
    expect(info.activity).toBe("Error");
  });
});

describe("formatLoopActivity", () => {
  test("running run includes trigger and session", () => {
    expect(
      formatLoopActivity(
        makeInput({ currentRun: makeRun({ status: "running", trigger: "cron", sessionId: "sess-9" }) }),
      ),
    ).toBe("Running cron run (session sess-9)");
  });

  test("running run without session omits session suffix", () => {
    expect(
      formatLoopActivity(
        makeInput({ currentRun: makeRun({ status: "running", trigger: "manual", sessionId: undefined }) }),
      ),
    ).toBe("Running manual run");
  });

  test("needs_user -> Waiting for user input", () => {
    expect(
      formatLoopActivity(makeInput({ currentRun: makeRun({ status: "needs_user" }) })),
    ).toBe("Waiting for user input");
  });

  test("active idle -> Ready", () => {
    expect(formatLoopActivity(makeInput({ status: "active" }))).toBe("Ready");
  });

  test("paused -> Paused", () => {
    expect(formatLoopActivity(makeInput({ status: "paused" }))).toBe("Paused");
  });

  test("disabled -> Disabled", () => {
    expect(formatLoopActivity(makeInput({ status: "disabled" }))).toBe("Disabled");
  });

  test("error -> Error", () => {
    expect(formatLoopActivity(makeInput({ status: "error" }))).toBe("Error");
  });
});

describe("formatRunHistoryLabel", () => {
  test("running -> Running", () => {
    expect(formatRunHistoryLabel("running")).toBe("Running");
  });

  test("succeeded -> Completed", () => {
    expect(formatRunHistoryLabel("succeeded")).toBe("Completed");
  });

  test("failed -> Failed", () => {
    expect(formatRunHistoryLabel("failed")).toBe("Failed");
  });

  test("budget_exceeded -> Failed", () => {
    expect(formatRunHistoryLabel("budget_exceeded")).toBe("Failed");
  });

  test("needs_user -> Awaiting Input", () => {
    expect(formatRunHistoryLabel("needs_user")).toBe("Awaiting Input");
  });

  test("skipped -> Skipped", () => {
    expect(formatRunHistoryLabel("skipped")).toBe("Skipped");
  });

  test("cancelled -> Cancelled", () => {
    expect(formatRunHistoryLabel("cancelled")).toBe("Cancelled");
  });
});

describe("formatRunHistoryBadgeClass", () => {
  test("succeeded uses accent badge", () => {
    expect(formatRunHistoryBadgeClass("succeeded")).toContain("bg-accent");
  });

  test("failed uses error badge", () => {
    expect(formatRunHistoryBadgeClass("failed")).toContain("bg-error");
  });

  test("needs_user uses warning badge", () => {
    expect(formatRunHistoryBadgeClass("needs_user")).toContain("bg-warning");
  });

  test("running uses success badge", () => {
    expect(formatRunHistoryBadgeClass("running")).toContain("bg-success");
  });
});
