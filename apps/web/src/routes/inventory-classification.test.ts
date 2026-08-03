import { describe, expect, test } from "bun:test";
import type { ProjectAutomationInventoryItem, ProjectSessionInventoryItem } from "../api/types";
import { automationInventoryEmptyMessage, classifyAutomationInventory, matchesAutomationInventory } from "./automations";
import { classifySessionInventory, presentSessionInventoryStatus, sessionAttentionLabels, sessionInventoryEmptyMessage } from "./project-sessions";

const automation = (id: string, status: "active" | "paused" | "disabled", invocationStatus?: "failed" | "missed" | "dispatched"): ProjectAutomationInventoryItem => ({
  automation: {
    id,
    projectSlug: "demo",
    origin: { kind: "direct" },
    name: id,
    trigger: { kind: "interval", everyMs: 60_000 },
    action: { kind: "start_session", message: "Run", location: "project" },
    status,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: `2026-08-0${id.length}T00:00:00.000Z`,
  },
  latestInvocation: invocationStatus ? {
    id: `${id}-invocation`, automationId: id, dueAt: "2026-08-03T00:00:00.000Z", status: invocationStatus, createdAt: "2026-08-03T00:00:00.000Z",
  } : null,
});

describe("inventory classification", () => {
  test("distinguishes a true empty inventory from filtered no-results", () => {
    expect(automationInventoryEmptyMessage(0)).toBe("No Automations yet. Create one to schedule or repeat work.");
    expect(automationInventoryEmptyMessage(2)).toBe("No Automations match this name, ID, action, or schedule.");
    expect(sessionInventoryEmptyMessage(0)).toBe("No Sessions yet. Start one directly or run work from a Todo.");
    expect(sessionInventoryEmptyMessage(2)).toBe("No Sessions match this title, ID, or source.");
  });

  test("assigns each Automation to exactly one operational group", () => {
    const groups = classifyAutomationInventory([
      automation("failed", "active", "failed"),
      automation("scheduled", "active", "dispatched"),
      automation("paused", "paused"),
      automation("inactive", "disabled"),
    ]);
    expect(Object.fromEntries(Object.entries(groups).map(([key, items]) => [key, items.map((item) => item.automation.id)]))).toEqual({
      "needs-attention": ["failed"], scheduled: ["scheduled"], paused: ["paused"], inactive: ["inactive"],
    });
  });

  test("filters Automations by schedule, linked Todo content, and latest run state", () => {
    const item = automation("linked", "active", "dispatched");
    const linked = {
      ...item,
      automation: {
        ...item.automation,
        origin: { kind: "todo" as const, todoId: "todo-1", sessionId: "session-1" },
        trigger: { kind: "cron" as const, expression: "0 9 * * 1", timezone: "Asia/Shanghai" },
      },
    };
    const todoContents = new Map([["todo-1", "Weekly dependency review\n\n## Checks\nInspect lockfile drift"]]);

    expect(matchesAutomationInventory(linked, "Asia/Shanghai", todoContents)).toBe(true);
    expect(matchesAutomationInventory(linked, "dependency review", todoContents)).toBe(true);
    expect(matchesAutomationInventory(linked, "lockfile drift", todoContents)).toBe(true);
    expect(matchesAutomationInventory(linked, "dispatched", todoContents)).toBe(true);
    expect(matchesAutomationInventory(linked, "unrelated", todoContents)).toBe(false);
  });

  test("gives attention precedence over running activity for Sessions", () => {
    const item = {
      session: { sessionId: "session-1", updatedAt: 1 },
      latestExecution: null,
    } as ProjectSessionInventoryItem;
    const groups = classifySessionInventory([item], new Map([["session-1", "running"]]), new Set(["session-1"]));
    expect(groups["needs-you"]).toEqual([item]);
    expect(groups.running).toEqual([]);
    expect(groups.recent).toEqual([]);
  });

  test("keeps failed and timed-out Sessions in Needs you instead of Recent", () => {
    const failed = {
      session: { sessionId: "failed", updatedAt: 2 },
      latestExecution: { id: "execution-failed", status: "failed", startedAt: 1, endedAt: 2 },
    } as ProjectSessionInventoryItem;
    const timedOut = {
      session: { sessionId: "timed-out", updatedAt: 1 },
      latestExecution: { id: "execution-timeout", status: "timed_out", startedAt: 1, endedAt: 2 },
    } as ProjectSessionInventoryItem;

    const groups = classifySessionInventory([timedOut, failed], new Map(), new Set());

    expect(groups["needs-you"]).toEqual([failed, timedOut]);
    expect(groups.running).toEqual([]);
    expect(groups.recent).toEqual([]);
  });

  test("preserves Permission and Question labels for Session attention", () => {
    const labels = sessionAttentionLabels([
      { rootSessionId: "question", view: { source: { type: "ask_user" } } },
      { rootSessionId: "permission", view: { source: { type: "tool_permission" } } },
    ]);

    expect([...labels]).toEqual([
      ["question", "Question"],
      ["permission", "Permission"],
    ]);
  });

  test("gives manual inspection precedence over its original request type", () => {
    const labels = sessionAttentionLabels([
      { rootSessionId: "inspection", view: { source: { type: "ask_user" }, requiresInspection: true } },
    ]);
    expect(labels.get("inspection")).toBe("Inspection");
  });

  test("presents every durable terminal and suspended Session state without calling it Idle", () => {
    const item = (status: NonNullable<ProjectSessionInventoryItem["latestExecution"]>["status"]) => ({
      session: { sessionId: status, updatedAt: 1 },
      latestExecution: { id: `execution-${status}`, status, startedAt: 1, ...(status === "running" || status === "suspended" ? {} : { endedAt: 2 }) },
    } as ProjectSessionInventoryItem);

    expect(presentSessionInventoryStatus(item("max_steps"), "idle")).toEqual({ label: "Stopped · Max steps", kind: "failed" });
    expect(presentSessionInventoryStatus(item("aborted"), "idle")).toEqual({ label: "Stopped · Aborted", kind: "stopped" });
    expect(presentSessionInventoryStatus(item("cancelled"), "idle")).toEqual({ label: "Stopped · Cancelled", kind: "stopped" });
    expect(presentSessionInventoryStatus(item("interrupted"), "idle")).toEqual({ label: "Stopped · Interrupted", kind: "stopped" });
    expect(presentSessionInventoryStatus(item("suspended"), "idle")).toEqual({ label: "Suspended", kind: "blocked" });
    expect(presentSessionInventoryStatus(item("failed"), "running")).toEqual({ label: "Running", kind: "running" });
  });
});
