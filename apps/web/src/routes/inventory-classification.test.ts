import { describe, expect, test } from "bun:test";
import type { ProjectAutomationInventoryItem, ProjectSessionInventoryItem } from "../api/types";
import { automationInventoryEmptyMessage, classifyAutomationInventory, matchesAutomationInventory } from "./automations";
import { presentAutomationSurface } from "../lib/automation-surface-presentation";
import { classifySessionInventory, matchesSessionInventory, presentSessionInventoryStatus, sessionAttentionLabels, sessionInventoryEmptyMessage } from "./project-sessions";

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

function presented(item: ProjectAutomationInventoryItem, needsYou = false) {
  return {
    item,
    presentation: presentAutomationSurface({
      item,
      attention: needsYou
        ? { kind: "start_session", sessions: [{ invocationId: "invocation", sessionId: "root", entries: [{} as never] }] }
        : { kind: "start_session", sessions: [] },
      sessionLinks: [],
      activityBySessionId: new Map(),
    }),
  };
}

describe("inventory classification", () => {
  test("distinguishes a true empty inventory from filtered no-results", () => {
    expect(automationInventoryEmptyMessage(0)).toBe("No Automations yet. Create one to schedule or repeat work.");
    expect(automationInventoryEmptyMessage(2)).toBe("No Automations match this name, ID, action, or schedule.");
    expect(sessionInventoryEmptyMessage(0)).toBe("No Sessions yet. Start one directly or run work from a Todo.");
    expect(sessionInventoryEmptyMessage(2)).toBe("No Sessions match this title, ID, or source.");
  });

  test("assigns each Automation to exactly one operational group", () => {
    const groups = classifyAutomationInventory([
      presented(automation("failed", "active", "failed")),
      presented(automation("human-gate", "active"), true),
      presented(automation("scheduled", "active", "dispatched")),
      presented(automation("paused", "paused")),
      presented(automation("inactive", "disabled")),
    ]);
    expect(Object.fromEntries(Object.entries(groups).map(([key, items]) => [key, items.map(({ item }) => item.automation.id)]))).toEqual({
      "needs-you": ["failed", "human-gate"], scheduled: ["scheduled"], paused: ["paused"], inactive: ["inactive"],
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

    const presentation = presented(linked).presentation;
    expect(matchesAutomationInventory(linked, "Asia/Shanghai", todoContents, presentation)).toBe(true);
    expect(matchesAutomationInventory(linked, "dependency review", todoContents, presentation)).toBe(true);
    expect(matchesAutomationInventory(linked, "lockfile drift", todoContents, presentation)).toBe(true);
    expect(matchesAutomationInventory(linked, "dispatched", todoContents, presentation)).toBe(true);
    expect(matchesAutomationInventory(linked, "unrelated", todoContents, presentation)).toBe(false);
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

  test("keeps an authoritative running execution in Running when the live family snapshot is idle", () => {
    const item = {
      session: {
        sessionId: "session-running",
        title: "Live work",
        agentName: "lead",
        source: { kind: "direct" },
        updatedAt: 1,
      },
      latestExecution: { id: "execution-running", status: "running", startedAt: 1 },
    } as ProjectSessionInventoryItem;
    const groups = classifySessionInventory([item], new Map(), new Set());
    expect(groups.running).toEqual([item]);
    expect(groups.recent).toEqual([]);
  });

  test("filters Sessions by linked Todo content and Automation name", () => {
    const todoSession = {
      session: {
        sessionId: "todo-session",
        title: "Dependency review",
        agentName: "lead",
        source: { kind: "todo", todoId: "todo-1", entry: "work" },
      },
      latestExecution: null,
    } as ProjectSessionInventoryItem;
    const automationSession = {
      session: {
        sessionId: "automation-session",
        title: "Nightly run",
        agentName: "lead",
        source: { kind: "automation", automationId: "automation-1", invocationId: "invocation-1", todoId: null },
      },
      latestExecution: null,
    } as ProjectSessionInventoryItem;
    const todoContents = new Map([["todo-1", "Inspect lockfile drift"]]);
    const automationNames = new Map([["automation-1", "Nightly dependency check"]]);

    expect(matchesSessionInventory(todoSession, "lockfile drift", "all", todoContents, automationNames)).toBe(true);
    expect(matchesSessionInventory(automationSession, "dependency check", "all", todoContents, automationNames)).toBe(true);
    expect(matchesSessionInventory(todoSession, "nightly", "automation", todoContents, automationNames)).toBe(false);
    expect(matchesSessionInventory(automationSession, "nightly", "automation", todoContents, automationNames)).toBe(true);
  });

  test("keeps failed, timed-out, and max-step Sessions in Needs you instead of Recent", () => {
    const failed = {
      session: { sessionId: "failed", updatedAt: 2 },
      latestExecution: { id: "execution-failed", status: "failed", startedAt: 1, endedAt: 2 },
    } as ProjectSessionInventoryItem;
    const timedOut = {
      session: { sessionId: "timed-out", updatedAt: 1 },
      latestExecution: { id: "execution-timeout", status: "timed_out", startedAt: 1, endedAt: 2 },
    } as ProjectSessionInventoryItem;
    const maxSteps = {
      session: { sessionId: "max-steps", updatedAt: 3 },
      latestExecution: { id: "execution-max-steps", status: "max_steps", startedAt: 1, endedAt: 2 },
    } as ProjectSessionInventoryItem;

    const groups = classifySessionInventory([timedOut, failed, maxSteps], new Map(), new Set());

    expect(groups["needs-you"]).toEqual([maxSteps, failed, timedOut]);
    expect(groups.running).toEqual([]);
    expect(groups.recent).toEqual([]);
  });

  test("classifies an authoritative waiting family as Needs you without relying on a separate HITL snapshot", () => {
    const item = {
      session: { sessionId: "waiting", updatedAt: 1 },
      latestExecution: { id: "execution-waiting", status: "suspended", startedAt: 1 },
    } as ProjectSessionInventoryItem;
    const groups = classifySessionInventory([item], new Map([["waiting", "waiting_for_human"]]), new Set());
    expect(groups["needs-you"]).toEqual([item]);
    expect(presentSessionInventoryStatus(item, "waiting_for_human")).toEqual({ label: "Needs you", kind: "needs_you", detail: "Waiting for response" });
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

    expect(presentSessionInventoryStatus(item("max_steps"), "idle")).toEqual({ label: "Failed", kind: "failed", detail: "Max steps" });
    expect(presentSessionInventoryStatus(item("aborted"), "idle")).toEqual({ label: "Stopped · Aborted", kind: "stopped" });
    expect(presentSessionInventoryStatus(item("cancelled"), "idle")).toEqual({ label: "Stopped · Cancelled", kind: "stopped" });
    expect(presentSessionInventoryStatus(item("interrupted"), "idle")).toEqual({ label: "Stopped · Interrupted", kind: "stopped" });
    expect(presentSessionInventoryStatus(item("suspended"), "idle")).toEqual({ label: "Suspended", kind: "blocked" });
    expect(presentSessionInventoryStatus(item("failed"), "running")).toEqual({ label: "Running", kind: "running" });
    expect(presentSessionInventoryStatus(item("timed_out"), "idle")).toEqual({ label: "Failed", kind: "failed", detail: "Timed out" });
    expect(presentSessionInventoryStatus(item("failed"), "idle", "Permission")).toEqual({ label: "Needs you", kind: "needs_you", detail: "Permission" });
  });
});
