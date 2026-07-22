import { describe, expect, test } from "bun:test";
import { automationInvocationStatusLabel, automationStatusLabel, automationVisualKind } from "./automation-status-presentation";
import { sessionFamilyVisual } from "./session-family-presentation";
import { presentSessionGoalStatus } from "./session-goal-presentation";

describe("workbench domain status presentation", () => {
  test("keeps Automation enablement static and distinct from runtime activity", () => {
    expect(automationVisualKind("active")).toBe("enabled");
    expect(automationVisualKind("paused")).toBe("paused");
    expect(automationVisualKind("disabled")).toBe("disabled");
  });

  test("presents Automation and Invocation statuses in sentence case", () => {
    expect(["active", "paused", "disabled"].map((status) => automationStatusLabel(status as "active" | "paused" | "disabled"))).toEqual(["Active", "Paused", "Disabled"]);
    expect(["pending", "dispatched", "failed", "cancelled", "missed"].map((status) => automationInvocationStatusLabel(status as "pending" | "dispatched" | "failed" | "cancelled" | "missed"))).toEqual(["Pending", "Dispatched", "Failed", "Cancelled", "Missed"]);
  });

  test("maps only authoritative Session family activity to a looping kind", () => {
    expect(sessionFamilyVisual("running")).toEqual({ kind: "running" });
    expect(sessionFamilyVisual("stopping")).toEqual({ kind: "running", tone: "warning" });
    expect(sessionFamilyVisual("idle")).toEqual({ kind: "idle" });
    expect(sessionFamilyVisual(undefined)).toEqual({ kind: "unknown" });
  });

  test("locks the five concise Goal status labels and semantics", () => {
    expect(presentSessionGoalStatus("active")).toEqual({ label: "Active", tone: "brand" });
    expect(presentSessionGoalStatus("paused")).toEqual({ label: "Paused", kind: "paused", tone: "warning" });
    expect(presentSessionGoalStatus("blocked")).toEqual({ label: "Blocked", kind: "blocked", tone: "warning" });
    expect(presentSessionGoalStatus("budget_limited")).toEqual({ label: "Budget limited", kind: "budget_limited", tone: "warning" });
    expect(presentSessionGoalStatus("complete")).toEqual({ label: "Completed", kind: "completed", tone: "success" });
  });
});
