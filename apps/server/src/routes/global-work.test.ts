import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AgentRuntime, ProjectInfo } from "@archcode/agent-core";
import type {
  Automation,
  AutomationInvocation,
  GlobalSSEHitlEntry,
  ProjectTodo,
  RootSessionSummary,
  SessionExecutionRecord,
} from "@archcode/protocol";

import { errorHandler } from "../error-handler";
import { createGlobalWorkRoutes } from "./global-work";

const goodProject: ProjectInfo = {
  slug: "good",
  name: "Good Project",
  workspaceRoot: "/projects/good",
  addedAt: "2026-08-01T00:00:00.000Z",
};
const badProject: ProjectInfo = {
  slug: "bad",
  name: "Bad Project",
  workspaceRoot: "/projects/bad",
  addedAt: "2026-08-01T00:00:00.000Z",
};

describe("global work read routes", () => {
  test("GET /api/home returns server-grouped attention, running, review, and upcoming rows", async () => {
    const todo = makeTodo();
    const work = rootSession("work", { kind: "todo", todoId: todo.id, entry: "work" }, 50);
    const hitlRoot = rootSession("hitl-root", { kind: "direct" }, 40);
    const failure = rootSession("failure", { kind: "direct" }, 30);
    const automation = makeAutomation();
    const failedAutomation = makeAutomation({
      id: "33333333-3333-4333-8333-333333333333",
      name: "Failing review",
    });
    const runtime = makeRuntime({
      projects: [goodProject, badProject],
      sessions: [work, hitlRoot, failure],
      todos: [todo],
      automations: [automation, failedAutomation],
      automationInvocations: new Map([[failedAutomation.id, {
        id: "44444444-4444-4444-8444-444444444444",
        automationId: failedAutomation.id,
        dueAt: "2026-08-03T00:00:00.000Z",
        status: "failed",
        createdAt: "2026-08-03T00:00:00.000Z",
        completedAt: "2026-08-03T00:01:00.000Z",
        error: "model unavailable",
      }]]),
      executions: new Map([
        [work.sessionId, [execution("completed", 60)]],
        [hitlRoot.sessionId, [execution("running", 41)]],
        [failure.sessionId, [execution("failed", 31)]],
      ]),
      hitl: [hitlEntry(hitlRoot.sessionId)],
      activities: new Map([[hitlRoot.sessionId, "running"]]),
      failBadProject: true,
    });
    const app = new Hono().route("/api", createGlobalWorkRoutes(runtime));
    app.onError(errorHandler);

    const response = await app.request("/api/home");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      needsYou: [
        { kind: "hitl", entityId: "hitl-1", status: "question", project: { slug: "good" } },
        { kind: "session", entityId: "failure", status: "failed", project: { slug: "good" } },
        { kind: "automation", entityId: failedAutomation.id, status: "failed", project: { slug: "good" } },
      ],
      running: [],
      readyToReview: [{ kind: "todo", entityId: todo.id, status: "ready_to_review" }],
      upcoming: [{ kind: "automation", entityId: automation.id, status: "scheduled" }],
      projectErrors: [{ project: { slug: "bad", name: "Bad Project" }, message: "corrupt project" }],
    });
    expect(body.readyToReview[0]?.title).toBe("Review the completed work Private PRD body");
  });

  test("a Goal-attention Session excludes its entire Todo work family from Ready to review", async () => {
    const todo = makeTodo();
    const blockedWork: RootSessionSummary = {
      ...rootSession("blocked-work", { kind: "todo", todoId: todo.id, entry: "work" }, 40),
      goal: {
        instanceId: "goal-1",
        generation: 1,
        objective: "Finish the Todo",
        status: "blocked",
        usage: {
          tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 },
          executionTimeMs: 0,
          executionCount: 0,
        },
        settlementReceipts: [],
        blockedReason: "Needs a decision",
        createdAt: 1,
        activatedAt: 1,
        updatedAt: 50,
      },
    };
    const completedWork = rootSession("completed-work", { kind: "todo", todoId: todo.id, entry: "work" }, 60);
    const runtime = makeRuntime({
      projects: [goodProject],
      sessions: [blockedWork, completedWork],
      todos: [todo],
      automations: [],
      executions: new Map([[completedWork.sessionId, [execution("completed", 61)]]]),
    });
    const app = new Hono().route("/api", createGlobalWorkRoutes(runtime));
    app.onError(errorHandler);

    const response = await app.request("/api/home");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.needsYou).toEqual([
      expect.objectContaining({ entityId: blockedWork.sessionId, status: "blocked" }),
    ]);
    expect(body.readyToReview).toEqual([]);
  });

  test("GET /api/search matches Todo content, caps at 100, and isolates project failures", async () => {
    const todos = Array.from({ length: 101 }, (_, index) => makeTodo({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      content: `Todo ${index}\n\nhidden needle content`,
    }));
    const runtime = makeRuntime({
      projects: [goodProject, badProject],
      sessions: [],
      todos,
      automations: [],
      executions: new Map(),
      failBadProject: true,
    });
    const app = new Hono().route("/api", createGlobalWorkRoutes(runtime));
    app.onError(errorHandler);

    const response = await app.request("/api/search?q=%20needle%20");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.results).toHaveLength(100);
    expect(body.truncated).toBe(true);
    expect(body.projectErrors).toEqual([{ project: { slug: "bad", name: "Bad Project" }, message: "corrupt project" }]);
    expect(body.results[0]).toEqual({
      kind: "todo",
      project: { slug: "good", name: "Good Project" },
      entityId: todos[0]!.id,
      title: "Todo 0 hidden needle content",
      href: `/projects/good/todos/${todos[0]!.id}`,
      context: "in_progress",
    });
    expect(body.results[0]).not.toHaveProperty("content");
  });

  test("GET /api/search enforces the trimmed 1-200 character boundary", async () => {
    const runtime = makeRuntime({ projects: [], sessions: [], todos: [], automations: [], executions: new Map() });
    const app = new Hono().route("/api", createGlobalWorkRoutes(runtime));
    app.onError(errorHandler);

    const empty = await app.request("/api/search?q=%20%20");
    const twoHundred = await app.request(`/api/search?q=${"a".repeat(200)}`);
    const twoHundredOne = await app.request(`/api/search?q=${"a".repeat(201)}`);

    expect(empty.status).toBe(400);
    expect(twoHundred.status).toBe(200);
    expect(twoHundredOne.status).toBe(400);
  });
});

function makeRuntime(input: {
  projects: ProjectInfo[];
  sessions: RootSessionSummary[];
  todos: ProjectTodo[];
  automations: Automation[];
  executions: Map<string, SessionExecutionRecord[]>;
  automationInvocations?: Map<string, AutomationInvocation>;
  hitl?: GlobalSSEHitlEntry[];
  activities?: Map<string, "running" | "waiting_for_human" | "resuming" | "stopping">;
  failBadProject?: boolean;
}): AgentRuntime {
  return {
    projectRegistry: { list: mock(async () => input.projects) },
    listSessions: mock(async (workspaceRoot: string) => {
      if (input.failBadProject && workspaceRoot === badProject.workspaceRoot) throw new Error("corrupt project");
      return input.sessions;
    }),
    listSessionInventory: mock(async (workspaceRoot: string) => {
      if (input.failBadProject && workspaceRoot === badProject.workspaceRoot) throw new Error("corrupt project");
      return input.sessions.map((session) => {
        const latest = input.executions.get(session.sessionId)?.at(-1);
        return {
          session,
          latestExecution: latest === undefined
            ? null
            : {
              id: latest.id,
              status: latest.status,
              startedAt: latest.startedAt,
              ...("endedAt" in latest ? { endedAt: latest.endedAt } : {}),
            },
        };
      });
    }),
    getSessionFile: mock(async (_workspaceRoot: string, sessionId: string) => ({
      ...input.sessions.find((session) => session.sessionId === sessionId)!,
      executions: input.executions.get(sessionId) ?? [],
    })),
    listAutomations: mock(async (workspaceRoot: string) => {
      if (input.failBadProject && workspaceRoot === badProject.workspaceRoot) throw new Error("corrupt project");
      return input.automations;
    }),
    listAutomationInventory: mock(async (workspaceRoot: string) => {
      if (input.failBadProject && workspaceRoot === badProject.workspaceRoot) throw new Error("corrupt project");
      return input.automations.map((automation) => ({
        automation,
        latestInvocation: input.automationInvocations?.get(automation.id) ?? null,
      }));
    }),
    listAutomationInvocations: mock(async () => []),
    contextResolver: { resolve: mock(async (workspaceRoot: string) => {
      if (input.failBadProject && workspaceRoot === badProject.workspaceRoot) throw new Error("corrupt project");
      return { todos: { listTodos: mock(async () => input.todos) } };
    }) },
    getProjectControlPlaneSnapshot: mock(async (workspaceRoot: string) => {
      if (input.failBadProject && workspaceRoot === badProject.workspaceRoot) throw new Error("corrupt project");
      return {
        sessionRuntime: {
          type: "session.runtime.snapshot",
          projectSlugs: [goodProject.slug],
          families: [...(input.activities ?? new Map())].map(([rootSessionId, activity]) => ({
            projectSlug: goodProject.slug,
            rootSessionId,
            activity,
          })),
          createdAt: 1,
        },
        hitl: {
          type: "hitl.snapshot",
          projectSlugs: [goodProject.slug],
          entries: input.hitl ?? [],
          createdAt: 1,
        },
      };
    }),
  } as unknown as AgentRuntime;
}

function rootSession(sessionId: string, source: RootSessionSummary["source"], updatedAt: number): RootSessionSummary {
  return {
    sessionId,
    cwd: goodProject.workspaceRoot,
    rootSessionId: sessionId,
    agentName: "lead",
    profile: "principal",
    activeSkillNames: [],
    modelSelection: { revision: 0 },
    title: sessionId,
    source,
    createdAt: 1,
    updatedAt,
  };
}

function execution(status: "running" | "completed" | "failed", startedAt: number): SessionExecutionRecord {
  return {
    id: `execution-${startedAt}`,
    status,
    startedAt,
    ...(status === "running" ? {} : { endedAt: startedAt + 1 }),
  } as SessionExecutionRecord;
}

function makeTodo(overrides: Partial<ProjectTodo> = {}): ProjectTodo {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    content: "Review the completed work\n\nPrivate PRD body",
    attachmentIds: [],
    status: "in_progress",
    revision: 1,
    createdAt: 1,
    updatedAt: 70,
    ...overrides,
  };
}

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    projectSlug: goodProject.slug,
    origin: { kind: "direct" },
    name: "Nightly review",
    trigger: { kind: "cron", expression: "0 1 * * *", timezone: "UTC" },
    action: { kind: "start_session", message: "Review", location: "project" },
    status: "active",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    nextFireAt: "2026-08-04T01:00:00.000Z",
    ...overrides,
  };
}

function hitlEntry(rootSessionId: string): GlobalSSEHitlEntry {
  return {
    projectSlug: goodProject.slug,
    hitlId: "hitl-1",
    ownerSessionId: rootSessionId,
    rootSessionId,
    view: {
      hitlId: "hitl-1",
      owner: { type: "session", id: rootSessionId },
      source: { type: "ask_user", toolCallId: "question-1" },
      status: "pending",
      displayPayload: { title: "Choose an option", summary: "Waiting for an answer", redacted: true },
      allowedActions: ["answer", "cancel"],
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
    },
  };
}
