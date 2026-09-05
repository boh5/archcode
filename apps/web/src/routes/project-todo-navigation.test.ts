import { describe, expect, test } from "bun:test";
import type { ProjectSessionInventoryItem, ProjectTodo, RootSessionSummary } from "@archcode/protocol";
import { deriveProjectTodoNeedsUser } from "./project-todo-presentation";
import { deriveProjectTodoNavigationProjection, type ProjectTodoNavigationFacts } from "./project-todo-navigation";

function todo(id: string, status: ProjectTodo["status"], extra: Partial<ProjectTodo> = {}): ProjectTodo {
  return { id, content: `# ${id}`, attachmentIds: [], status, revision: 1, createdAt: 1, updatedAt: 1, ...extra };
}

function session(id: string, source: RootSessionSummary["source"], goalStatus?: "blocked" | "budget_limited"): ProjectSessionInventoryItem {
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
      source,
      ...(goalStatus === undefined ? {} : { goal: { status: goalStatus } as RootSessionSummary["goal"] }),
      createdAt: 1,
      updatedAt: 1,
    },
    latestExecution: null,
  };
}

function facts(overrides: Partial<ProjectTodoNavigationFacts> = {}): ProjectTodoNavigationFacts {
  return {
    slug: "demo",
    pathname: "/projects/demo/todos",
    todos: [],
    sessions: [],
    automations: [],
    activityBySessionId: new Map(),
    attentionBySessionId: new Map(),
    attentionCountBySessionId: new Map(),
    todosState: "ready",
    sessionsState: "ready",
    automationsState: "ready",
    hitlState: "ready",
    runtimeState: "ready",
    ...overrides,
  };
}

describe("Project Todo navigator projection", () => {
  test("derives Needs you only from exact linked HITL or Work/Automation Goal gates", () => {
    const item = todo("todo-1", "in_progress");
    const discussion = session("discussion", { kind: "todo", todoId: item.id, entry: "discussion" });
    const work = session("work", { kind: "todo", todoId: item.id, entry: "work" }, "blocked");
    const automation = session("automation", { kind: "automation", automationId: "a", invocationId: "i", todoId: item.id }, "budget_limited");
    expect(deriveProjectTodoNeedsUser(item, [discussion], new Map([["discussion", "Question"]]))).toBe(true);
    expect(deriveProjectTodoNeedsUser(item, [work], new Map())).toBe(true);
    expect(deriveProjectTodoNeedsUser(item, [automation], new Map())).toBe(true);
    expect(deriveProjectTodoNeedsUser(item, [discussion], new Map())).toBe(false);
    expect(deriveProjectTodoNeedsUser({ ...item, status: "rejected" }, [work], new Map())).toBe(false);
    expect(deriveProjectTodoNeedsUser({ ...item, archivedAt: 2 }, [work], new Map())).toBe(false);
  });

  test("keeps Todo-only groups, exposes the exact action count, and selects the route-owned row", () => {
    const first = todo("first", "in_progress");
    const second = todo("second", "in_progress");
    const ready = todo("ready", "ready");
    const projection = deriveProjectTodoNavigationProjection(facts({
      pathname: "/projects/demo/todos/first/work",
      selectedTodoId: first.id,
      todos: [first, second, ready],
      sessions: [session("first-work", { kind: "todo", todoId: first.id, entry: "work" }, "blocked")],
      attentionBySessionId: new Map([["first-work", "Permission"]]),
      attentionCountBySessionId: new Map([["first-work", 2]]),
    }));

    expect(projection.needsYou.rows.map((row) => row.todo.id)).toEqual(["first"]);
    expect(projection.running.rows).toEqual([]);
    expect(projection.inProgress.rows.map((row) => row.todo.id)).toEqual(["first", "second"]);
    expect(projection.ready.rows.map((row) => row.todo.id)).toEqual(["ready"]);
    expect(projection.needsYou.rows[0]?.current).toBe(true);
    expect(projection.needsYou.rows[0]?.attentionCount).toBe(3);
    expect(projection.inProgress.rows[0]?.current).toBe(false);
    expect(projection.allTodos.current).toBe(false);

    const contentRoute = deriveProjectTodoNavigationProjection(facts({
      pathname: "/projects/demo/todos/first",
      selectedTodoId: first.id,
      todos: [first],
      sessions: [session("first-work", { kind: "todo", todoId: first.id, entry: "work" }, "blocked")],
    }));
    expect(contentRoute.needsYou.rows[0]?.current).toBe(false);
    expect(contentRoute.inProgress.rows[0]?.current).toBe(true);
  });

  test("does not render fake counts while dependencies load or fail", () => {
    const loading = deriveProjectTodoNavigationProjection(facts({ todosState: "loading", hitlState: "loading" }));
    expect(loading.allTodos.count).toBeUndefined();
    expect(loading.needsYou.count).toBeUndefined();
    expect(loading.needsYou.state).toBe("loading");
    expect(loading.running).toEqual({ rows: [], state: "loading" });
    expect(loading.inProgress).toEqual({ rows: [], state: "loading" });
    expect(loading.ready).toEqual({ rows: [], state: "loading" });

    const failed = deriveProjectTodoNavigationProjection(facts({ sessionsState: "error" }));
    expect(failed.needsYou.count).toBeUndefined();
    expect(failed.needsYou.state).toBe("error");
    expect(failed.runs.count).toBeUndefined();
    expect(failed.runs.state).toBe("error");

    const todoFailed = deriveProjectTodoNavigationProjection(facts({ todosState: "error" }));
    expect(todoFailed.inProgress).toEqual({ rows: [], state: "error" });
    expect(todoFailed.ready).toEqual({ rows: [], state: "error" });
  });

  test("derives Running only from exact live Todo-linked family activity and selects one stable target", () => {
    const idea = todo("idea", "idea");
    const ready = todo("ready", "ready");
    const done = todo("done", "done");
    const inProgress = todo("in-progress", "in_progress");
    const needs = todo("needs", "idea");
    const rejected = todo("rejected", "rejected");
    const archived = todo("archived", "done", { archivedAt: 20 });
    const ideaOlder = session("idea-z", { kind: "todo", todoId: idea.id, entry: "discussion" });
    const ideaTieWinner = { ...session("idea-a", { kind: "todo", todoId: idea.id, entry: "discussion" }), session: { ...session("idea-a", { kind: "todo", todoId: idea.id, entry: "discussion" }).session, updatedAt: 4 } };
    const ideaTieLoser = { ...session("idea-b", { kind: "todo", todoId: idea.id, entry: "work" }), session: { ...session("idea-b", { kind: "todo", todoId: idea.id, entry: "work" }).session, updatedAt: 4 } };
    const readySession = session("ready-live", { kind: "todo", todoId: ready.id, entry: "work" });
    const doneSession = session("done-live", { kind: "automation", automationId: "a", invocationId: "i", todoId: done.id });
    const waitingSession = session("waiting", { kind: "todo", todoId: inProgress.id, entry: "work" });
    const needsSession = session("needs-live", { kind: "todo", todoId: needs.id, entry: "discussion" });
    const rejectedSession = session("rejected-live", { kind: "todo", todoId: rejected.id, entry: "work" });
    const archivedSession = session("archived-live", { kind: "todo", todoId: archived.id, entry: "work" });
    const failedOnly = {
      ...session("failed-only", { kind: "todo", todoId: inProgress.id, entry: "work" }),
      latestExecution: { id: "failed", status: "failed" as const, startedAt: 1, endedAt: 2 },
    };
    const direct = session("direct-live", { kind: "direct" });
    const sessions = [ideaOlder, ideaTieLoser, ideaTieWinner, readySession, doneSession, waitingSession, needsSession, rejectedSession, archivedSession, failedOnly, direct];
    const projection = deriveProjectTodoNavigationProjection(facts({
      pathname: "/projects/demo/sessions/ready-live",
      selectedSessionId: "ready-live",
      todos: [idea, ready, done, inProgress, needs, rejected, archived],
      sessions,
      activityBySessionId: new Map([
        ["idea-z", "running"], ["idea-a", "running"], ["idea-b", "running"],
        ["ready-live", "resuming"], ["done-live", "stopping"], ["waiting", "waiting_for_human"],
        ["needs-live", "running"], ["rejected-live", "running"], ["archived-live", "running"],
        ["failed-only", "idle"], ["direct-live", "running"],
      ]),
      attentionBySessionId: new Map([["needs-live", "Question"]]),
    }));

    expect(projection.running.rows.map((row) => [row.todo.id, row.targetSessionId, row.current])).toEqual([
      ["idea", "idea-a", false],
      ["ready", "ready-live", true],
      ["done", "done-live", false],
    ]);
    expect(projection.running.count).toBe(3);
    expect(projection.ready.rows.filter((row) => row.current)).toEqual([]);
    expect(projection.needsYou.rows.map((row) => row.todo.id)).toEqual(["needs"]);
    expect(projection.inProgress.rows.map((row) => row.todo.id)).toEqual(["in-progress"]);
    expect(projection.ready.rows.map((row) => row.todo.id)).toEqual(["ready"]);
  });

  test("uses canonical Active Todos and active Session families for navigator counts", () => {
    const running = {
      ...session("running", { kind: "direct" }),
      latestExecution: { id: "run", status: "running" as const, startedAt: 2 },
    };
    const failed = {
      ...session("failed", { kind: "direct" }),
      latestExecution: { id: "fail", status: "failed" as const, startedAt: 2, endedAt: 3 },
    };
    const completed = {
      ...session("completed", { kind: "direct" }),
      latestExecution: { id: "done", status: "completed" as const, startedAt: 2, endedAt: 3 },
    };
    const waiting = session("waiting", { kind: "direct" });
    const attention = session("attention", { kind: "direct" });
    const projection = deriveProjectTodoNavigationProjection(facts({
      todos: [
        todo("active", "ready"),
        todo("rejected", "rejected"),
        todo("archived", "done", { archivedAt: 2 }),
      ],
      sessions: [running, failed, completed, waiting, attention],
      activityBySessionId: new Map([["waiting", "waiting_for_human"]]),
      attentionBySessionId: new Map([["attention", "Question"]]),
    }));

    expect(projection.allTodos.count).toBe(1);
    expect(projection.runs.count).toBe(4);
  });

  test("keeps exact Needs-you rows authoritative when only Schedules fails", () => {
    const item = todo("todo-1", "in_progress");
    const projection = deriveProjectTodoNavigationProjection(facts({
      todos: [item],
      sessions: [session("work", { kind: "todo", todoId: item.id, entry: "work" }, "blocked")],
      attentionBySessionId: new Map([["work", "Permission"]]),
      attentionCountBySessionId: new Map([["work", 2]]),
      automationsState: "error",
    }));

    expect(projection.needsYou.state).toBe("ready");
    expect(projection.needsYou.count).toBe(1);
    expect(projection.needsYou.rows[0]?.attentionCount).toBe(3);
    expect(projection.needsYou.rows[0]?.operationalState).toBeUndefined();
    expect(projection.schedules.state).toBe("error");
  });

  test("maps Direct Sessions to Runs and non-Todo Automation Sessions to Schedules", () => {
    const direct = session("direct", { kind: "direct" });
    const automation = session("scheduled", { kind: "automation", automationId: "a", invocationId: "i", todoId: null });
    expect(deriveProjectTodoNavigationProjection(facts({
      pathname: "/projects/demo/sessions/direct",
      selectedSessionId: "direct",
      sessions: [direct, automation],
    })).runs.current).toBe(true);
    expect(deriveProjectTodoNavigationProjection(facts({
      pathname: "/projects/demo/sessions/scheduled",
      selectedSessionId: "scheduled",
      sessions: [direct, automation],
    })).schedules.current).toBe(true);
  });
});
