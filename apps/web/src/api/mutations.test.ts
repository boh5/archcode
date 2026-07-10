import { afterEach, describe, expect, mock, test } from "bun:test";
import { apiFetch } from "./client";

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
const TEST_PROJECT_SLUG = "test-project";

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.document = originalDocument;
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("web goal mutation API calls", () => {
  test("createGoal calls POST /api/projects/:slug/goals with optional worktree isolation", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/goals`);
      expect(init?.method).toBe("POST");
      return jsonResponse({ id: "goal-new", title: "New Goal" }, { status: 201 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch(`/api/projects/${TEST_PROJECT_SLUG}/goals`, {
      method: "POST",
      body: { objective: "Simplify Goal", acceptanceCriteria: "Reviewer can decide DONE from logs and diff.", useWorktree: true },
    });

    expect(result).toMatchObject({ id: "goal-new" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("runGoal calls POST /api/projects/:slug/goals/:goalId/run", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/goals/goal-1/run`);
      expect(init?.method).toBe("POST");
      return jsonResponse({ id: "goal-1", status: "running" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch(`/api/projects/${TEST_PROJECT_SLUG}/goals/goal-1/run`, { method: "POST", body: {} });
    expect(result).toMatchObject({ id: "goal-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("retryGoal calls POST /api/projects/:slug/goals/:goalId/retry", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/goals/goal-1/retry`);
      expect(init?.method).toBe("POST");
      return jsonResponse({ id: "goal-1", status: "running" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch(`/api/projects/${TEST_PROJECT_SLUG}/goals/goal-1/retry`, { method: "POST", body: {} });
    expect(result).toMatchObject({ id: "goal-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("cancelGoal calls POST /api/projects/:slug/goals/:goalId/cancel", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/goals/goal-1/cancel`);
      expect(init?.method).toBe("POST");
      return jsonResponse({ id: "goal-1", status: "cancelled" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch(`/api/projects/${TEST_PROJECT_SLUG}/goals/goal-1/cancel`, { method: "POST" });
    expect(result).toMatchObject({ id: "goal-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("web HITL mutation API calls", () => {
  test("respondHitl calls POST /api/projects/:slug/hitl/:id/respond", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/hitl/hitl-1/respond`);
      expect(init?.method).toBe("POST");
      return jsonResponse({ ok: true, hitlId: "hitl-1" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch(`/api/projects/${TEST_PROJECT_SLUG}/hitl/hitl-1/respond`, {
      method: "POST",
      body: { decision: "approved" },
    });
    expect(result).toEqual({ ok: true, hitlId: "hitl-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("cancelHitl calls POST /api/projects/:slug/hitl/:id/cancel", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/hitl/hitl-1/cancel`);
      expect(init?.method).toBe("POST");
      return jsonResponse({ ok: true, hitlId: "hitl-1" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch(`/api/projects/${TEST_PROJECT_SLUG}/hitl/hitl-1/cancel`, { method: "POST" });
    expect(result).toEqual({ ok: true, hitlId: "hitl-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("respondHitl with review outcome sends project-scoped endpoint", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/projects/demo/hitl/review-1/respond");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.outcome).toBe("DONE");
      return jsonResponse({ ok: true, hitlId: "review-1" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch("/api/projects/demo/hitl/review-1/respond", {
      method: "POST",
      body: { outcome: "DONE" },
    });
    expect(result).toEqual({ ok: true, hitlId: "review-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("cancelHitl with reason sends project-scoped endpoint", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/projects/demo/hitl/hitl-cancel/cancel");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.reason).toBe("No longer needed");
      return jsonResponse({ ok: true, hitlId: "hitl-cancel" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch("/api/projects/demo/hitl/hitl-cancel/cancel", {
      method: "POST",
      body: { reason: "No longer needed" },
    });
    expect(result).toEqual({ ok: true, hitlId: "hitl-cancel" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("respondHitl never calls global /api/hitl/:id/respond endpoint", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).not.toBe("/api/hitl/hitl-1/respond");
      expect(url).not.toMatch(/^\/api\/hitl\/[^/]+\/respond$/);
      expect(url).toBe("/api/projects/demo/hitl/hitl-1/respond");
      return jsonResponse({ ok: true, hitlId: "hitl-1" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch("/api/projects/demo/hitl/hitl-1/respond", {
      method: "POST",
      body: { decision: "approved" },
    });
    expect(result).toEqual({ ok: true, hitlId: "hitl-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("respondHitl never calls /api/questions endpoint", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).not.toMatch(/^\/api\/questions\//);
      expect(url).not.toMatch(/^\/api\/questions\b/);
      expect(url).toBe("/api/projects/demo/hitl/hitl-q1/respond");
      return jsonResponse({ ok: true, hitlId: "hitl-q1" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch("/api/projects/demo/hitl/hitl-q1/respond", {
      method: "POST",
      body: { answers: ["yes"] },
    });
    expect(result).toEqual({ ok: true, hitlId: "hitl-q1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("cancelHitl never calls /api/permissions endpoint", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).not.toMatch(/^\/api\/permissions\//);
      expect(url).not.toMatch(/^\/api\/permissions\b/);
      expect(url).toBe("/api/projects/demo/hitl/hitl-perm/cancel");
      return jsonResponse({ ok: true, hitlId: "hitl-perm" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch("/api/projects/demo/hitl/hitl-perm/cancel", { method: "POST" });
    expect(result).toEqual({ ok: true, hitlId: "hitl-perm" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("web loop mutation invalidation helpers", () => {
  function createFakeQc() {
    const calls: Array<{ queryKey: readonly unknown[]; exact?: boolean }> = [];
    return {
      invalidateQueries: mock((opts: { queryKey: readonly unknown[]; exact?: boolean }) => {
        calls.push(opts);
        return Promise.resolve();
      }),
      getCalls: () => calls,
    };
  }

  test("invalidateLoopAfterCreate invalidates project loop list and dashboard active loops", async () => {
    const qc = createFakeQc();
    const { invalidateLoopAfterCreate } = await import("./mutations");

    await invalidateLoopAfterCreate(qc, TEST_PROJECT_SLUG);

    expect(qc.getCalls()).toEqual([
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops"] },
      { queryKey: ["loops", "active"] },
    ]);
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  test("loop trigger mutation invalidates run-log, generated state, guardrail keys, and dashboard keys", async () => {
    const qc = createFakeQc();
    const { invalidateLoopAfterTrigger } = await import("./mutations");

    await invalidateLoopAfterTrigger(qc, TEST_PROJECT_SLUG, "loop-1");

    expect(qc.getCalls()).toEqual([
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "loop-1"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "loop-1", "runs"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "loop-1", "state"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "loop-1", "budget"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "loop-1", "collisions"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "loop-1", "integrations"] },
      { queryKey: ["loops", "active"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "kill-state"] },
    ]);
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(8);
  });

  test("invalidateLoopAfterUpdate invalidates list, detail, generated state, and dashboard keys", async () => {
    const qc = createFakeQc();
    const { invalidateLoopAfterUpdate } = await import("./mutations");

    await invalidateLoopAfterUpdate(qc, TEST_PROJECT_SLUG, "loop-1");

    expect(qc.getCalls()).toEqual([
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "loop-1"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "loop-1", "state"] },
      { queryKey: ["loops", "active"] },
    ]);
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(4);
  });

  test("invalidateLoopAfterPauseResume invalidates list, detail, generated state, guardrail keys, and dashboard keys", async () => {
    const qc = createFakeQc();
    const { invalidateLoopAfterPauseResume } = await import("./mutations");

    await invalidateLoopAfterPauseResume(qc, TEST_PROJECT_SLUG, "loop-1");

    expect(qc.getCalls()).toEqual([
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "loop-1"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "loop-1", "state"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "loop-1", "budget"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "loop-1", "collisions"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "loop-1", "integrations"] },
      { queryKey: ["loops", "active"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "kill-state"] },
    ]);
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(8);
  });

  test("invalidateLoopAfterCancelCurrentRun invalidates detail, runs, state, budget, collisions, integrations, project loops, active loops, and kill state", async () => {
    const qc = createFakeQc();
    const { invalidateLoopAfterCancelCurrentRun } = await import("./mutations");

    await invalidateLoopAfterCancelCurrentRun(qc, TEST_PROJECT_SLUG, "loop-1");

    expect(qc.getCalls()).toEqual([
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "loop-1"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "loop-1", "runs"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "loop-1", "state"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "loop-1", "budget"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "loop-1", "collisions"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "loop-1", "integrations"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops"] },
      { queryKey: ["loops", "active"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "kill-state"] },
    ]);
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(9);
  });

  test("invalidateLoopAfterGlobalKill invalidates kill state, project loops, active loops, and all per-loop guardrail caches via prefix", async () => {
    const qc = createFakeQc();
    const { invalidateLoopAfterGlobalKill } = await import("./mutations");

    await invalidateLoopAfterGlobalKill(qc, TEST_PROJECT_SLUG);

    expect(qc.getCalls()).toEqual([
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops", "kill-state"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops"] },
      { queryKey: ["loops", "active"] },
      { queryKey: ["projects", TEST_PROJECT_SLUG, "loops"], exact: false },
    ]);
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(4);
  });
});

describe("web loop mutation URL contracts", () => {
  test("createLoop posts to /api/projects/:slug/loops with template-oriented body", async () => {
    const { buildCreateLoopRequestBody } = await import("./mutations");
    const limits = {
      maxIterationsPerRun: 10,
      maxTokensPerRun: 120000,
      maxWallClockMsPerRun: 900000,
      maxRunsPerDay: 2,
      softThresholdRatio: 0.8,
      hardThresholdRatio: 1,
    };
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/loops`);
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.templateId).toBe("watch_report");
      expect(body.limits).toEqual(limits);
      expect(body.title).toBeUndefined();
      expect(body.author).toBeUndefined();
      expect(body.config).toBeUndefined();
      expect(body.presetId).toBeUndefined();
      expect(body.budget).toBeUndefined();
      expect(body.extraTools).toBeUndefined();
      return jsonResponse({ loop: { loopId: "loop-new", status: "active" } }, { status: 201 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch(`/api/projects/${TEST_PROJECT_SLUG}/loops`, {
      method: "POST",
      body: buildCreateLoopRequestBody({
        templateId: "watch_report",
        schedule: { kind: "manual" },
        approvalPolicy: "interactive",
        budget: limits,
      }),
    });

    expect(result).toMatchObject({ loop: { loopId: "loop-new" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("updateLoop request body is flat and never sends raw config", async () => {
    const { buildUpdateLoopRequestBody } = await import("./mutations");
    const body = buildUpdateLoopRequestBody({
      status: "paused",
      templateId: "maintain_fix",
      schedule: { kind: "manual" },
      approvalPolicy: "explicit_per_run",
      budget: {
        maxIterationsPerRun: 12,
        maxTokensPerRun: 160000,
        maxWallClockMsPerRun: 1200000,
        maxRunsPerDay: 2,
        softThresholdRatio: 0.8,
        hardThresholdRatio: 1,
      },
      triggers: [],
      useWorktree: false,
    });

    expect(body).toMatchObject({
      status: "paused",
      templateId: "maintain_fix",
      schedule: { kind: "manual" },
      approvalPolicy: "explicit_per_run",
      limits: expect.objectContaining({ maxIterationsPerRun: 12 }),
      triggers: [],
      useWorktree: false,
    });
    expect(body.config).toBeUndefined();
    expect(body.title).toBeUndefined();
    expect(body.presetId).toBeUndefined();
    expect(body.budget).toBeUndefined();
    expect(body.extraTools).toBeUndefined();
  });

  test("loop trigger mutation calls POST /api/projects/:slug/loops/:loopId/trigger", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/loops/loop-1/trigger`);
      expect(init?.method).toBe("POST");
      return jsonResponse({ report: { runId: "run-1", loopId: "loop-1", status: "running", trigger: "manual", startedAt: 1_000 } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch(`/api/projects/${TEST_PROJECT_SLUG}/loops/loop-1/trigger`, { method: "POST" });
    expect(result).toMatchObject({ report: { runId: "run-1" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("pauseLoop calls POST /api/projects/:slug/loops/:loopId/pause", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/loops/loop-1/pause`);
      expect(init?.method).toBe("POST");
      return jsonResponse({ loop: { loopId: "loop-1", status: "paused" } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch(`/api/projects/${TEST_PROJECT_SLUG}/loops/loop-1/pause`, { method: "POST" });
    expect(result).toMatchObject({ loop: { loopId: "loop-1", status: "paused" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("resumeLoop calls POST /api/projects/:slug/loops/:loopId/resume", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/loops/loop-1/resume`);
      expect(init?.method).toBe("POST");
      return jsonResponse({ loop: { loopId: "loop-1", status: "active" } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch(`/api/projects/${TEST_PROJECT_SLUG}/loops/loop-1/resume`, { method: "POST" });
    expect(result).toMatchObject({ loop: { loopId: "loop-1", status: "active" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("updateLoop calls PATCH /api/projects/:slug/loops/:loopId with status", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/loops/loop-1`);
      expect(init?.method).toBe("PATCH");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.status).toBe("paused");
      expect(body.config).toBeUndefined();
      return jsonResponse({ loop: { loopId: "loop-1", status: "paused" } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch(`/api/projects/${TEST_PROJECT_SLUG}/loops/loop-1`, {
      method: "PATCH",
      body: { status: "paused" },
    });
    expect(result).toMatchObject({ loop: { loopId: "loop-1", status: "paused" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("useCancelLoopCurrentRun posts to /api/projects/:slug/loops/:loopId/runs/current/cancel", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/loops/loop-1/runs/current/cancel`);
      expect(init?.method).toBe("POST");
      return jsonResponse({ ok: true, loopId: "loop-1", runId: "run-1", status: "cancelled" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch(`/api/projects/${TEST_PROJECT_SLUG}/loops/loop-1/runs/current/cancel`, { method: "POST" });
    expect(result).toMatchObject({ ok: true, loopId: "loop-1", runId: "run-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("useActivateLoopGlobalKill posts to /api/projects/:slug/loops/kill-all with optional body", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/loops/kill-all`);
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.activatedBy).toBe("user");
      return jsonResponse({ killState: { globalKillActive: true, activatedBy: "user" } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch(`/api/projects/${TEST_PROJECT_SLUG}/loops/kill-all`, {
      method: "POST",
      body: { activatedBy: "user" },
    });
    expect(result).toMatchObject({ killState: { globalKillActive: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("useClearLoopGlobalKill deletes /api/projects/:slug/loops/kill-all", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/loops/kill-all`);
      expect(init?.method).toBe("DELETE");
      return jsonResponse({ killState: { globalKillActive: false } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiFetch(`/api/projects/${TEST_PROJECT_SLUG}/loops/kill-all`, { method: "DELETE" });
    expect(result).toMatchObject({ killState: { globalKillActive: false } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("web has no agent-core imports", () => {
  test("queries.ts does not import from @archcode/agent-core or @archcode/server", async () => {
    const content = await Bun.file(
      new URL("./queries.ts", import.meta.url),
    ).text();
    expect(content).not.toContain("@archcode/agent-core");
    expect(content).not.toContain("@archcode/server");
  });

  test("mutations.ts does not import from @archcode/agent-core or @archcode/server", async () => {
    const content = await Bun.file(
      new URL("./mutations.ts", import.meta.url),
    ).text();
    expect(content).not.toContain("@archcode/agent-core");
    expect(content).not.toContain("@archcode/server");
  });

  test("types.ts does not import from @archcode/agent-core or @archcode/server", async () => {
    const content = await Bun.file(
      new URL("./types.ts", import.meta.url),
    ).text();
    expect(content).not.toContain("@archcode/agent-core");
    expect(content).not.toContain("@archcode/server");
  });
});

describe("web mutations do not call legacy permission/question endpoints", () => {
  test("mutations.ts has no /api/permissions or /api/questions calls", async () => {
    const content = await Bun.file(
      new URL("./mutations.ts", import.meta.url),
    ).text();
    expect(content).not.toContain("/api/permissions");
    expect(content).not.toContain("/api/questions");
    expect(content).not.toContain("usePostPermissionResponse");
    expect(content).not.toContain("usePostQuestionAnswer");
  });
});
