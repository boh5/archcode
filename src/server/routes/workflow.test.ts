import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SpecraRuntime } from "../../main";
import { WorkflowArtifactManager } from "../../agents/workflow/artifacts";
import { WorkflowStateManager } from "../../agents/workflow/state";
import { ProjectRegistry } from "../../projects/registry";
import { saveSessionTranscript } from "../../store/helpers";
import { createSessionStore } from "../../store/store";
import { createServerApp } from "../app";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "workflow-routes");

const createScopedSessionStore = createSessionStore as unknown as typeof createSessionStore & ((sessionId: string, workspaceRoot: string) => ReturnType<typeof createSessionStore>);

function createTestRuntime(projectRegistry: ProjectRegistry): SpecraRuntime {
  return {
    sessionAgentManager: {
      get: () => undefined,
      getOrCreate: async () => undefined,
      dispose: () => undefined,
      disposeAll: () => undefined,
      getByWorkspace: () => [],
      isTombstoned: () => false,
      acquireSlot: () => undefined,
      releaseSlot: () => undefined,
      abortAndDispose: async () => undefined,
    },
    projectRegistry,
    mcpManager: undefined,
    toolRegistry: undefined,
    providerRegistry: undefined,
    warnings: [],
    contextResolver: undefined,
    agentFor: async (_root: string, _sid: string) => undefined,
  } as unknown as SpecraRuntime;
}

async function makeWorkspace(name: string): Promise<string> {
  const workspaceRoot = join(tempRoot, "workspaces", name);
  await mkdir(workspaceRoot, { recursive: true });
  return workspaceRoot;
}

async function createTestApp(testName: string) {
  const homeDir = join(tempRoot, "homes", testName);
  await mkdir(homeDir, { recursive: true });
  const projectRegistry = new ProjectRegistry({ homeDir });
  const runtime = createTestRuntime(projectRegistry);
  const workspaceRoot = await makeWorkspace(testName);
  const project = await projectRegistry.add({ workspaceRoot, name: testName });

  return {
    app: createServerApp(runtime, { dev: true }).app,
    project,
    workspaceRoot,
    projectRegistry,
  };
}

async function saveEmptySession(
  workspaceRoot: string,
  sessionId: string,
): Promise<void> {
  const store = createScopedSessionStore(sessionId, workspaceRoot);
  store.setState({
    sessionId,
    createdAt: Date.now(),
    title: null,
    messages: [],
    steps: [],
    todos: [],
    reminders: [],
    childSessionIds: new Set(),
    parentSessionId: undefined,
    subAgentDescriptions: new Map(),
  });
  await saveSessionTranscript(store.getState(), workspaceRoot);
}

describe("workflow routes", () => {
  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  describe("GET /api/projects/:slug/sessions/:sessionId/workflow", () => {
    test("returns the workflow referencing the given session", async () => {
      const { app, project, workspaceRoot } = await createTestApp("session-workflow-found");
      const sessionId = "my-session-id";
      const workflowId = "wf-1";

      await saveEmptySession(workspaceRoot, sessionId);

      const stateManager = new WorkflowStateManager(workspaceRoot);
      await stateManager.create({
        id: workflowId,
        sessionIds: { orchestrator: sessionId },
      });

      const res = await app.request(
        `/api/projects/${project.slug}/sessions/${sessionId}/workflow`,
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.workflow).toBeDefined();
      expect(body.workflow.id).toBe(workflowId);
      expect(body.workflow.sessionIds).toEqual({ orchestrator: sessionId });
    });

    test("returns 200 with null workflow when session has no matching workflow", async () => {
      const { app, project, workspaceRoot } = await createTestApp("session-no-workflow");
      const sessionId = "orphan-session";

      await saveEmptySession(workspaceRoot, sessionId);

      const res = await app.request(
        `/api/projects/${project.slug}/sessions/${sessionId}/workflow`,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ workflow: null });
    });

    test("returns 404 when session does not exist", async () => {
      const { app, project } = await createTestApp("session-not-exists");

      const res = await app.request(
        `/api/projects/${project.slug}/sessions/non-existent-session/workflow`,
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: "SESSION_NOT_FOUND", message: "Session not found: non-existent-session" },
      });
    });

    test("returns 404 when project does not exist", async () => {
      const { app } = await createTestApp("project-not-exists");

      const res = await app.request(
        "/api/projects/missing-project/sessions/some-session/workflow",
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: "PROJECT_NOT_FOUND", message: "Project not found: missing-project" },
      });
    });

    test("finds workflow via taskSessionIds as well", async () => {
      const { app, project, workspaceRoot } = await createTestApp("via-tasksession-ids");
      const sessionId = "task-session-id";
      const workflowId = "wf-tasks";

      await saveEmptySession(workspaceRoot, sessionId);

      const stateManager = new WorkflowStateManager(workspaceRoot);
      await stateManager.create({
        id: workflowId,
        taskSessionIds: { foreman: sessionId },
      });

      const res = await app.request(
        `/api/projects/${project.slug}/sessions/${sessionId}/workflow`,
      );

      expect(res.status).toBe(200);
      expect((await res.json()).workflow.id).toBe(workflowId);
    });
  });

  describe("GET /api/projects/:slug/workflows/:workflowId/artifacts/:name", () => {
    test("returns PRD artifact body", async () => {
      const { app, project, workspaceRoot } = await createTestApp("prd-artifact");
      const workflowId = "wf-prd";
      const artifactBody = "# PRD\n\nProduct Requirements.";

      const stateManager = new WorkflowStateManager(workspaceRoot);
      const artifactManager = new WorkflowArtifactManager(workspaceRoot, stateManager);
      await stateManager.create({ id: workflowId });
      await artifactManager.write({
        workflowId,
        kind: "PRD",
        path: "PRD.md",
        frontmatter: { owner: "product" },
        content: artifactBody,
      });

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/${workflowId}/artifacts/PRD`,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ body: artifactBody });
    });

    test("returns SPEC artifact body", async () => {
      const { app, project, workspaceRoot } = await createTestApp("spec-artifact");
      const workflowId = "wf-spec";
      const artifactBody = "# SPEC\n\nTechnical spec.";

      const stateManager = new WorkflowStateManager(workspaceRoot);
      const artifactManager = new WorkflowArtifactManager(workspaceRoot, stateManager);
      await stateManager.create({ id: workflowId });
      await artifactManager.write({
        workflowId,
        kind: "SPEC",
        path: "SPEC.md",
        frontmatter: { version: "1" },
        content: artifactBody,
      });

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/${workflowId}/artifacts/SPEC`,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ body: artifactBody });
    });

    test("returns TASKS artifact body", async () => {
      const { app, project, workspaceRoot } = await createTestApp("tasks-artifact");
      const workflowId = "wf-tasks";
      const artifactBody = "# Tasks\n\n- Task 1";

      const stateManager = new WorkflowStateManager(workspaceRoot);
      const artifactManager = new WorkflowArtifactManager(workspaceRoot, stateManager);
      await stateManager.create({ id: workflowId });
      await artifactManager.write({
        workflowId,
        kind: "TASKS",
        path: "TASKS.md",
        frontmatter: { version: "1" },
        content: artifactBody,
      });

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/${workflowId}/artifacts/TASKS`,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ body: artifactBody });
    });

    test("returns FINAL_REPORT artifact body", async () => {
      const { app, project, workspaceRoot } = await createTestApp("final-report-artifact");
      const workflowId = "wf-final";
      const artifactBody = "# Final Report\n\nAll done.";

      const stateManager = new WorkflowStateManager(workspaceRoot);
      const artifactManager = new WorkflowArtifactManager(workspaceRoot, stateManager);
      await stateManager.create({ id: workflowId });
      await artifactManager.write({
        workflowId,
        kind: "FINAL_REPORT",
        path: "FINAL_REPORT.md",
        frontmatter: { version: "1" },
        content: artifactBody,
      });

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/${workflowId}/artifacts/FINAL_REPORT`,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ body: artifactBody });
    });

    test("returns CRITIC_REPORT artifact body from workflow state", async () => {
      const { app, project, workspaceRoot } = await createTestApp("critic-artifact");
      const workflowId = "wf-critic";
      const artifactBody = "## Review\n\nLooks good.";

      const stateManager = new WorkflowStateManager(workspaceRoot);
      const artifactManager = new WorkflowArtifactManager(workspaceRoot, stateManager);
      await stateManager.create({ id: workflowId });
      await artifactManager.write({
        workflowId,
        kind: "CRITIC_REPORT",
        path: "critic-reports/prd.md",
        frontmatter: { reviewer: "critic" },
        content: artifactBody,
      });

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/${workflowId}/artifacts/CRITIC_REPORT`,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ body: artifactBody });
    });

    test("returns EVIDENCE artifact body from workflow state", async () => {
      const { app, project, workspaceRoot } = await createTestApp("evidence-artifact");
      const workflowId = "wf-evidence";
      const artifactBody = "Test output evidence";

      const stateManager = new WorkflowStateManager(workspaceRoot);
      const artifactManager = new WorkflowArtifactManager(workspaceRoot, stateManager);
      await stateManager.create({ id: workflowId });
      await artifactManager.write({
        workflowId,
        kind: "EVIDENCE",
        path: "evidence/test-output.txt",
        frontmatter: { source: "test" },
        content: artifactBody,
      });

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/${workflowId}/artifacts/EVIDENCE`,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ body: artifactBody });
    });

    test("returns 404 for non-existent workflow", async () => {
      const { app, project } = await createTestApp("missing-workflow-artifact");
      const workflowId = "non-existent-workflow";

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/${workflowId}/artifacts/PRD`,
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: "WORKFLOW_NOT_FOUND", message: `Workflow not found: ${workflowId}` },
      });
    });

    test("returns 404 for non-existent artifact", async () => {
      const { app, project, workspaceRoot } = await createTestApp("missing-artifact");
      const workflowId = "wf-no-artifact";

      const stateManager = new WorkflowStateManager(workspaceRoot);
      await stateManager.create({ id: workflowId });

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/${workflowId}/artifacts/PRD`,
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: "ARTIFACT_NOT_FOUND", message: `Artifact not found: PRD in workflow ${workflowId}` },
      });
    });

    test("returns 400 for invalid artifact name", async () => {
      const { app, project } = await createTestApp("invalid-artifact-name");

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/wf-any/artifacts/INVALID`,
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: {
          code: "BAD_REQUEST",
          message: "Invalid artifact name: INVALID. Must be one of PRD, SPEC, TASKS, CRITIC_REPORT, EVIDENCE, FINAL_REPORT",
        },
      });
    });

    test("returns 404 for non-existent project slug", async () => {
      const { app } = await createTestApp("missing-project-artifact");

      const res = await app.request(
        "/api/projects/missing/workflows/wf-1/artifacts/PRD",
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: "PROJECT_NOT_FOUND", message: "Project not found: missing" },
      });
    });
  });
});
