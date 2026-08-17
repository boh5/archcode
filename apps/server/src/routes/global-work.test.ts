import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AgentRuntime, ProjectInfo } from "@archcode/agent-core";
import type { Automation, ProjectTodo, SessionSummary } from "@archcode/protocol";

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

describe("global work search route", () => {
  test("GET /api/search matches Todo content, caps at 100, and isolates project failures", async () => {
    const todos = Array.from({ length: 101 }, (_, index): ProjectTodo => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      content: `Todo ${index}\n\nhidden needle content`,
      attachmentIds: [],
      status: "in_progress",
      revision: 1,
      createdAt: index,
      updatedAt: index,
    }));
    const runtime = makeRuntime([goodProject, badProject], todos, true);
    const app = new Hono().route("/api", createGlobalWorkRoutes(runtime));
    app.onError(errorHandler);

    const response = await app.request("/api/search?q=%20needle%20");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.results).toHaveLength(100);
    expect(body.truncated).toBe(true);
    expect(body.projectErrors).toEqual([{ project: { slug: "bad", name: "Bad Project" }, message: "Project work is temporarily unavailable" }]);
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
    const runtime = makeRuntime([], [], false);
    const app = new Hono().route("/api", createGlobalWorkRoutes(runtime));
    app.onError(errorHandler);

    const empty = await app.request("/api/search?q=%20%20");
    const twoHundred = await app.request(`/api/search?q=${"a".repeat(200)}`);
    const twoHundredOne = await app.request(`/api/search?q=${"a".repeat(201)}`);

    expect(empty.status).toBe(400);
    expect(twoHundred.status).toBe(200);
    expect(twoHundredOne.status).toBe(400);
  });

  test("GET /api/search returns exact deep links for every current work surface", async () => {
    const project = { ...goodProject, slug: "needle-project", name: "Needle Project" };
    const todo: ProjectTodo = {
      id: "11111111-1111-4111-8111-111111111111",
      content: "Needle Todo",
      attachmentIds: [],
      status: "ready",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const session: SessionSummary = {
      sessionId: "22222222-2222-4222-8222-222222222222",
      cwd: project.workspaceRoot,
      rootSessionId: "22222222-2222-4222-8222-222222222222",
      agentName: "lead",
      profile: "principal",
      activeSkillNames: [],
      modelSelection: { revision: 0 },
      title: "Needle Session",
      source: { kind: "direct" },
      createdAt: 1,
      updatedAt: 1,
    };
    const automation: Automation = {
      id: "33333333-3333-4333-8333-333333333333",
      projectSlug: project.slug,
      origin: { kind: "direct" },
      name: "Needle Automation",
      trigger: { kind: "interval", everyMs: 60_000 },
      action: { kind: "start_session", message: "Needle run", location: "project" },
      status: "active",
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
    };
    const runtime = makeRuntime([project], [todo], false, [session], [automation]);
    const app = new Hono().route("/api", createGlobalWorkRoutes(runtime));

    const response = await app.request("/api/search?q=needle");
    const body = await response.json() as { results: Array<{ kind: string; href: string }> };

    expect(response.status).toBe(200);
    expect(body.results.map(({ kind, href }) => ({ kind, href }))).toEqual([
      { kind: "project", href: "/projects/needle-project/todos" },
      { kind: "todo", href: `/projects/needle-project/todos/${todo.id}` },
      { kind: "session", href: `/projects/needle-project/sessions/${session.sessionId}` },
      { kind: "automation", href: `/projects/needle-project/automations/${automation.id}` },
    ]);
  });

  test("GET /api/search presents an archived Todo by its effective lifecycle", async () => {
    const todo: ProjectTodo = {
      id: "44444444-4444-4444-8444-444444444444",
      content: "Archived needle Todo",
      attachmentIds: [],
      status: "in_progress",
      archivedAt: 2,
      revision: 2,
      createdAt: 1,
      updatedAt: 2,
    };
    const runtime = makeRuntime([goodProject], [todo], false);
    const app = new Hono().route("/api", createGlobalWorkRoutes(runtime));

    const response = await app.request("/api/search?q=archived");
    const body = await response.json() as { results: Array<{ context?: string }> };

    expect(response.status).toBe(200);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]?.context).toBe("archived");
  });
});

function makeRuntime(
  projects: readonly ProjectInfo[],
  todos: readonly ProjectTodo[],
  failBadProject: boolean,
  sessions: readonly SessionSummary[] = [],
  automations: readonly Automation[] = [],
): AgentRuntime {
  return {
    projectRegistry: { list: mock(async () => [...projects]) },
    listSessions: mock(async (workspaceRoot: string) => {
      if (failBadProject && workspaceRoot === badProject.workspaceRoot) throw new Error("corrupt project");
      return [...sessions];
    }),
    listAutomations: mock(async () => [...automations]),
    contextResolver: {
      resolve: mock(async () => ({ todos: { listTodos: mock(async () => [...todos]) } })),
    },
  } as unknown as AgentRuntime;
}
