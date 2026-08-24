import { describe, expect, test } from "bun:test";
import type {
  ProjectAutomationInventoryItem,
  ProjectSessionInventoryItem,
  ProjectTodo,
  RootSessionSummary,
  SessionFamilyActivity,
} from "@archcode/protocol";
import { deriveProjectTodoNeedsUser, deriveProjectTodoOperationalState, type ProjectTodoOperationalFacts } from "./project-todo-presentation";

const todo: ProjectTodo = {
  id: "todo-1",
  content: "Ship the work",
  attachmentIds: [],
  status: "in_progress",
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};

function workSession(
  id: string,
  updatedAt: number,
  status: NonNullable<ProjectSessionInventoryItem["latestExecution"]>["status"] | null,
  overrides: Partial<RootSessionSummary> = {},
): ProjectSessionInventoryItem {
  return {
    session: {
      sessionId: id,
      rootSessionId: id,
      cwd: "/repo",
      agentName: "lead",
      profile: "principal",
      activeSkillNames: [],
      modelSelection: { revision: 0 },
      title: id,
      source: { kind: "todo", todoId: todo.id, entry: "work" },
      createdAt: updatedAt,
      updatedAt,
      ...overrides,
    },
    latestExecution: status === null ? null : {
      id: `${id}-execution`,
      status,
      startedAt: updatedAt,
      ...(status === "running" || status === "suspended" ? {} : { endedAt: updatedAt }),
    },
  };
}

function automation(
  latestInvocation: ProjectAutomationInventoryItem["latestInvocation"] = null,
  nextFireAt?: string,
): ProjectAutomationInventoryItem {
  return {
    automation: {
      id: "automation-1",
      projectSlug: "demo",
      origin: { kind: "todo", todoId: todo.id, sessionId: "automation-setup" },
      name: "Check nightly",
      trigger: { kind: "interval", everyMs: 60_000 },
      action: { kind: "start_session", message: "Check", location: "project" },
      status: "active",
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
      ...(nextFireAt === undefined ? {} : { nextFireAt }),
    },
    latestInvocation,
  };
}

function facts(overrides: Partial<ProjectTodoOperationalFacts> = {}): ProjectTodoOperationalFacts {
  return {
    todo,
    sessions: [],
    automations: [],
    activityBySessionId: new Map(),
    attentionBySessionId: new Map(),
    authoritative: true,
    ...overrides,
  };
}

describe("Todo operational state", () => {
  test("waits for authoritative facts and keeps quiet lifecycle rows undecorated", () => {
    expect(deriveProjectTodoOperationalState(facts({ authoritative: false }))).toBeUndefined();
    expect(deriveProjectTodoOperationalState(facts({ todo: { ...todo, status: "ready" } }))).toBeUndefined();
    expect(deriveProjectTodoOperationalState(facts())).toBeUndefined();
  });

  test("gives unresolved user attention precedence over active work", () => {
    const session = workSession("work-1", 10, "failed");
    const activity = new Map<string, SessionFamilyActivity>([["work-1", "running"]]);
    expect(deriveProjectTodoOperationalState(facts({
      sessions: [session],
      activityBySessionId: activity,
      attentionBySessionId: new Map([["work-1", "Permission"]]),
    }))).toEqual({ label: "Needs you", detail: "Permission", kind: "needs_you" });
  });

  test("projects linked Discussion attention without changing an Idea lifecycle", () => {
    const discussion = workSession("discussion", 10, null, {
      source: { kind: "todo", todoId: todo.id, entry: "discussion" },
    });
    expect(deriveProjectTodoOperationalState(facts({
      todo: { ...todo, status: "idea" },
      sessions: [discussion],
      attentionBySessionId: new Map([["discussion", "Question"]]),
    }))).toEqual({ label: "Needs you", detail: "Question", kind: "needs_you" });
  });

  test("uses exact linked-root HITL and never infers Needs you from family activity", () => {
    const discussion = workSession("discussion", 20, null, {
      source: { kind: "todo", todoId: todo.id, entry: "discussion" },
    });
    expect(deriveProjectTodoNeedsUser(todo, [discussion], new Map([["discussion", "Question"]]))).toBe(true);
    expect(deriveProjectTodoOperationalState(facts({
      sessions: [discussion],
      attentionBySessionId: new Map([["discussion", "Question"]]),
    }))).toEqual({ label: "Needs you", detail: "Question", kind: "needs_you" });

    const waiting = workSession("waiting", 30, null);
    expect(deriveProjectTodoNeedsUser(todo, [waiting], new Map())).toBe(false);
    expect(deriveProjectTodoOperationalState(facts({
      sessions: [waiting],
      activityBySessionId: new Map([["waiting", "waiting_for_human"]]),
    }))).toEqual({ label: "Waiting", detail: "Waiting for dependency", kind: "pending" });
  });

  test("shows current work instead of an older terminal failure", () => {
    const failed = workSession("failed", 10, "failed");
    const current = workSession("current", 20, null);
    expect(deriveProjectTodoOperationalState(facts({
      sessions: [failed, current],
      activityBySessionId: new Map([["current", "resuming"]]),
    }))).toEqual({ label: "Working", detail: "Resuming", kind: "running" });
  });

  test("uses the latest work result for attention or review", () => {
    expect(deriveProjectTodoOperationalState(facts({
      sessions: [workSession("failed", 10, "timed_out")],
    }))).toEqual({ label: "Failed", detail: "Timed out", kind: "failed" });
    expect(deriveProjectTodoOperationalState(facts({
      sessions: [workSession("completed", 20, "completed"), workSession("failed", 10, "failed")],
    }))).toEqual({ label: "Ready to review", kind: "completed" });
  });

  test("links Automation-originated Sessions through their durable Todo source after Automation removal", () => {
    const session = workSession("automation-run", Date.parse("2026-08-03T01:00:00.000Z"), null, {
      source: {
        kind: "automation",
        automationId: "automation-1",
        invocationId: "invocation-1",
        todoId: todo.id,
      },
    });
    expect(deriveProjectTodoOperationalState(facts({
      sessions: [session],
      automations: [],
      activityBySessionId: new Map([["automation-run", "running"]]),
    }))).toEqual({ label: "Working", detail: "Running", kind: "running" });
  });

  test("keeps dispatch distinct from completion and exposes a future schedule", () => {
    const invocation = {
      id: "invocation-1",
      automationId: "automation-1",
      dueAt: "2026-08-03T02:00:00.000Z",
      status: "dispatched" as const,
      createdAt: "2026-08-03T02:00:00.000Z",
      dispatchedAt: "2026-08-03T02:00:00.000Z",
    };
    expect(deriveProjectTodoOperationalState(facts({
      sessions: [workSession("completed", Date.parse("2026-08-03T01:00:00.000Z"), "completed")],
      automations: [automation(invocation, "2026-08-04T02:00:00.000Z")],
    }))).toEqual({ label: "Scheduled", kind: "enabled" });
  });

  test("surfaces only current linked Automation failures", () => {
    const invocation = {
      id: "invocation-1",
      automationId: "automation-1",
      dueAt: "2026-08-03T02:00:00.000Z",
      status: "missed" as const,
      createdAt: "2026-08-03T02:00:00.000Z",
      completedAt: "2026-08-03T02:00:00.000Z",
    };
    expect(deriveProjectTodoOperationalState(facts({
      automations: [automation(invocation, "2026-08-04T02:00:00.000Z")],
    }))).toEqual({ label: "Failed", detail: "Automation missed", kind: "failed" });
  });
});
