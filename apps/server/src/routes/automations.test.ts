import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ProjectRegistry, silentLogger } from "@archcode/agent-core";
import type { Automation, AutomationInvocation } from "@archcode/protocol";
import { errorHandler } from "../error-handler";
import { createAutomationsRoutes } from "./automations";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "automations-routes");

function automation(): Automation {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "project",
    createdFromSessionId: "44444444-4444-4444-8444-444444444444",
    name: "Daily check",
    status: "active",
    trigger: { kind: "cron", expression: "0 9 * * 1", timezone: "Asia/Shanghai" },
    action: { kind: "start_session", message: "/skill use check\nReview the project.", location: "project" },
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
}

async function fixture(name: string) {
  const homeDir = join(tempRoot, "home", name);
  const workspaceRoot = join(tempRoot, "workspace", name);
  await mkdir(homeDir, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  const projectRegistry = new ProjectRegistry({ homeDir, logger: silentLogger });
  const project = await projectRegistry.add({ workspaceRoot, name: "Project" });
  const item = automation();
  const runtime = {
    projectRegistry,
    listAutomations: mock(async () => [item]),
    readAutomation: mock(async () => item),
    updateAutomation: mock(async (_root: string, _id: string, input: Partial<Pick<Automation, "name" | "trigger" | "action">>) => ({ ...item, ...input })),
    deleteAutomation: mock(async () => undefined),
    pauseAutomation: mock(async () => ({ ...item, status: "paused" as const })),
    resumeAutomation: mock(async () => ({ ...item, status: "active" as const })),
    runAutomationNow: mock(async (): Promise<AutomationInvocation> => ({
      id: "22222222-2222-4222-8222-222222222222",
      automationId: item.id,
      dueAt: "2026-07-13T00:00:00.000Z",
      status: "pending",
      executionId: "33333333-3333-4333-8333-333333333333",
      createdAt: "2026-07-13T00:00:00.000Z",
    })),
    listAutomationInvocations: mock(async () => []),
  };
  const app = createAutomationsRoutes(runtime as unknown as Parameters<typeof createAutomationsRoutes>[0]);
  app.onError(errorHandler);
  return { app, item, project, runtime };
}

describe("automation routes", () => {
  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("does not expose direct Automation creation", async () => {
    const { app, project } = await fixture("create");
    const res = await app.request(`/${project.slug}/automations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Morning review",
        trigger: { kind: "cron", expression: "0 9 * * 1", timezone: "Asia/Shanghai" },
        action: { kind: "start_session", message: "/skill use review", location: "worktree" },
      }),
    });

    expect(res.status).toBe(404);
  });

  test("run now creates an invocation without mutating the trigger", async () => {
    const { app, item, project, runtime } = await fixture("run-now");
    const res = await app.request(`/${project.slug}/automations/${item.id}/run-now`, { method: "POST" });

    expect(res.status).toBe(202);
    expect((await res.json() as { invocation: AutomationInvocation }).invocation.status).toBe("pending");
    expect(runtime.runAutomationNow).toHaveBeenCalledWith(project.workspaceRoot, item.id);
  });

  test("rejects provenance changes through the update route", async () => {
    const { app, item, project, runtime } = await fixture("immutable-provenance");
    const res = await app.request(`/${project.slug}/automations/${item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ createdFromSessionId: crypto.randomUUID() }),
    });

    expect(res.status).toBe(400);
    expect(runtime.updateAutomation).not.toHaveBeenCalled();
  });

  test("rejects malformed JSON, invalid IDs, and invalid invocation limits", async () => {
    const { app, item, project, runtime } = await fixture("validation");
    const malformed = await app.request(`/${project.slug}/automations/${item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    const invalidId = await app.request(`/${project.slug}/automations/not-a-uuid`);
    const invalidLimit = await app.request(`/${project.slug}/automations/${item.id}/invocations?limit=0`);

    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(invalidId.status).toBe(400);
    expect(invalidLimit.status).toBe(400);
    expect(runtime.updateAutomation).not.toHaveBeenCalled();
  });

  test("exposes read, update, pause, resume, history, and delete as project-scoped operations", async () => {
    const { app, item, project, runtime } = await fixture("operations");
    const read = await app.request(`/${project.slug}/automations/${item.id}`);
    const update = await app.request(`/${project.slug}/automations/${item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed check" }),
    });
    const pause = await app.request(`/${project.slug}/automations/${item.id}/pause`, { method: "POST" });
    const resume = await app.request(`/${project.slug}/automations/${item.id}/resume`, { method: "POST" });
    const history = await app.request(`/${project.slug}/automations/${item.id}/invocations?limit=5`);
    const remove = await app.request(`/${project.slug}/automations/${item.id}`, { method: "DELETE" });

    expect(read.status).toBe(200);
    expect(update.status).toBe(200);
    expect(pause.status).toBe(200);
    expect(resume.status).toBe(200);
    expect(history.status).toBe(200);
    expect(remove.status).toBe(200);
    expect(runtime.readAutomation).toHaveBeenCalledWith(project.workspaceRoot, item.id);
    expect(runtime.updateAutomation).toHaveBeenCalledWith(project.workspaceRoot, item.id, { name: "Renamed check" });
    expect(runtime.pauseAutomation).toHaveBeenCalledWith(project.workspaceRoot, item.id);
    expect(runtime.resumeAutomation).toHaveBeenCalledWith(project.workspaceRoot, item.id);
    expect(runtime.listAutomationInvocations).toHaveBeenCalledWith(project.workspaceRoot, item.id, 5);
    expect(runtime.deleteAutomation).toHaveBeenCalledWith(project.workspaceRoot, item.id);
  });
});
