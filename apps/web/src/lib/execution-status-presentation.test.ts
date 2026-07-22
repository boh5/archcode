import { describe, expect, test } from "bun:test";
import type { SessionExecutionRecord, ToolChildSessionLinkStatus } from "@archcode/protocol";
import { childExecutionVisualKind, executionVisualKind, presentChildExecutionStatus, presentExecutionStatus } from "./execution-status-presentation";

describe("execution status presentation", () => {
  test("shows an unresolved input checkpoint as current action", () => {
    expect(presentExecutionStatus("waiting_for_human")).toEqual({
      productStatus: "needs_you",
      label: "Needs you",
    });
  });

  test("shows a resolved checkpoint as received and links its continuation", () => {
    expect(presentExecutionStatus("waiting_for_human", {
      executionId: "execution-1",
      state: "continued",
      continuationExecutionId: "execution-2",
    })).toEqual({
      productStatus: "completed",
      label: "Input received",
      continuationExecutionId: "execution-2",
    });
  });

  test("keeps accepted, continuing, and cancelled checkpoint copy distinct", () => {
    expect(presentExecutionStatus("waiting_for_human", {
      executionId: "execution-1",
      state: "response_received",
    })).toMatchObject({ label: "Input received", detail: "Resuming" });
    expect(presentExecutionStatus("waiting_for_human", {
      executionId: "execution-1",
      state: "continuing",
      continuationExecutionId: "execution-2",
    })).toMatchObject({ label: "Input received", detail: "Continuing" });
    expect(presentExecutionStatus("waiting_for_human", {
      executionId: "execution-1",
      state: "cancelled",
    })).toEqual({ productStatus: "stopped", label: "Stopped", detail: "Input cancelled" });
  });

  test("projects every terminal stop into Stopped while preserving its reason", () => {
    const cases: Array<[SessionExecutionRecord["status"], string]> = [
      ["max_steps", "Max steps"],
      ["failed", "Failed"],
      ["aborted", "Aborted"],
      ["cancelled", "Cancelled"],
      ["timed_out", "Timed out"],
      ["interrupted", "Interrupted"],
    ];

    for (const [status, detail] of cases) {
      expect(presentExecutionStatus(status)).toEqual({
        productStatus: "stopped",
        label: "Stopped",
        detail,
      });
    }
  });

  test("uses the same product states for current child sessions", () => {
    const cases: Array<[ToolChildSessionLinkStatus, string, string | undefined]> = [
      ["linked", "Running", "Starting"],
      ["running", "Running", undefined],
      ["waiting_for_human", "Needs you", undefined],
      ["cancelling", "Running", "Stopping"],
      ["completed", "Completed", undefined],
      ["failed", "Stopped", "Failed"],
      ["timed_out", "Stopped", "Timed out"],
      ["cancelled", "Stopped", "Cancelled"],
      ["interrupted", "Stopped", "Interrupted"],
    ];

    for (const [status, label, detail] of cases) {
      const presentation = presentChildExecutionStatus(status);
      expect(presentation.label).toBe(label);
      expect(presentation.detail).toBe(detail);
    }
  });

  test("keeps failure visuals distinct from neutral stops without changing copy", () => {
    expect(executionVisualKind("failed")).toBe("failed");
    expect(executionVisualKind("timed_out")).toBe("failed");
    expect(executionVisualKind("max_steps")).toBe("failed");
    expect(executionVisualKind("cancelled")).toBe("stopped");
    expect(executionVisualKind("interrupted")).toBe("stopped");
    expect(childExecutionVisualKind("failed")).toBe("failed");
    expect(childExecutionVisualKind("timed_out")).toBe("failed");
    expect(childExecutionVisualKind("cancelled")).toBe("stopped");
    expect(childExecutionVisualKind("interrupted")).toBe("stopped");
    expect(childExecutionVisualKind("waiting_for_human")).toBe("needs_you");
  });
});
