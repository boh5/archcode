import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SpecraRuntime } from "@specra/agent-core";
import { WorkflowArtifactManager } from "@specra/agent-core";
import { WorkflowStateManager } from "@specra/agent-core";
import { ProjectRegistry, silentLogger } from "@specra/agent-core";
import { createServerApp } from "../app";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "workflow-routes");

function createTestRuntime(projectRegistry: ProjectRegistry) {
  const runtime = {
    projectRegistry,
    mcpManager: undefined,
    toolRegistry: undefined,
    skillService: undefined,
    providerRegistry: undefined,
    warnings: [],
    contextResolver: undefined,
    createSession: async () => {
      const sessionId = crypto.randomUUID();
      return { sessionId, createdAt: Date.now(), title: null, messages: [], steps: [], todos: [], reminders: [] };
    },
    getSessionFile: async () => {
      throw new Error("not implemented");
    },
    listSessions: async () => [],
    startSessionExecution: () => {
      throw new Error("not implemented");
    },
    abortSessionExecution: () => false,
    abortSessionExecutionAndWait: async () => undefined,
    abortAllSessionExecutions: async () => undefined,
    isSessionExecutionRunning: () => false,
    getSessionExecution: () => undefined,
    subscribeSessionEvents: () => () => undefined,
    deleteSession: async () => {
      throw new Error("not implemented");
    },
    disposeSessionAgent: () => undefined,
    disposeAllSessionAgents: () => undefined,
    isSessionTombstoned: () => false,
    dispatchCommand: async () => null,
    requestPermission: async () => "timeout",
    respondPermission: () => false,
    requestQuestion: async () => ({ isError: true, reason: "Cancelled" }),
    respondQuestion: () => false,
    cleanupDeferredSession: () => undefined,
    notifyRuntimeShutdown: () => undefined,
  } as unknown as SpecraRuntime;

  return { runtime };
}

async function makeWorkspace(name: string): Promise<string> {
  const workspaceRoot = join(tempRoot, "workspaces", name);
  await mkdir(workspaceRoot, { recursive: true });
  return workspaceRoot;
}

async function createTestApp(testName: string) {
  const homeDir = join(tempRoot, "homes", testName);
  await mkdir(homeDir, { recursive: true });
  const projectRegistry = new ProjectRegistry({ homeDir, logger: silentLogger });
  const { runtime } = createTestRuntime(projectRegistry);
  const workspaceRoot = await makeWorkspace(testName);
  const project = await projectRegistry.add({ workspaceRoot, name: testName });

  return {
    app: createServerApp(runtime, { dev: true }).app,
    project,
    workspaceRoot,
    projectRegistry,
  };
}

describe("workflow routes", () => {
  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  describe("GET /api/projects/:slug/workflows/:workflowId", () => {
    test("returns the requested workflow", async () => {
      const { app, project, workspaceRoot } = await createTestApp("workflow-found");
      const workflowId = "wf-1";

      const stateManager = new WorkflowStateManager(workspaceRoot);
      await stateManager.create({
        id: workflowId,
        type: "full_feature",
        sessionIds: { orchestrator: "session-1" },
      });

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/${workflowId}`,
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.workflow).toBeDefined();
      expect(body.workflow.id).toBe(workflowId);
      expect(body.workflow.sessionIds).toEqual({ orchestrator: "session-1" });
    });

    test("returns 404 for non-existent workflow", async () => {
      const { app, project } = await createTestApp("workflow-not-found");
      const workflowId = "missing-workflow";

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/${workflowId}`,
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: "WORKFLOW_NOT_FOUND", message: `Workflow not found: ${workflowId}` },
      });
    });

    test("returns 404 for non-existent project slug", async () => {
      const { app } = await createTestApp("workflow-missing-project");

      const res = await app.request(
        "/api/projects/missing-project/workflows/wf-1",
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: "PROJECT_NOT_FOUND", message: "Project not found: missing-project" },
      });
    });
  });

  describe("GET /api/projects/:slug/workflows/:workflowId/artifacts/:name", () => {
    for (const artifact of [
      { kind: "RESEARCH", body: "# Research\n\nInitial findings." },
      { kind: "HANDOFF_SUMMARY", body: "# Handoff Summary\n\nContinue from here." },
      { kind: "INTERACTIONS", body: "# Interactions\n\n- Asked for approval." },
    ] as const) {
      test(`returns ${artifact.kind} artifact body`, async () => {
        const { app, project, workspaceRoot } = await createTestApp(`${artifact.kind.toLowerCase()}-artifact`);
        const workflowId = `wf-${artifact.kind.toLowerCase()}`;

        const stateManager = new WorkflowStateManager(workspaceRoot);
        const artifactManager = new WorkflowArtifactManager(workspaceRoot, stateManager);
        await stateManager.create({ id: workflowId, type: "full_feature" });
        await artifactManager.write({
          workflowId,
          kind: artifact.kind,
          path: `${artifact.kind}.md`,
          frontmatter: { version: "1" },
          content: artifact.body,
        });

        const res = await app.request(
          `/api/projects/${project.slug}/workflows/${workflowId}/artifacts/${artifact.kind}`,
        );

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ body: artifact.body });
      });
    }

    test("returns PRD artifact body", async () => {
      const { app, project, workspaceRoot } = await createTestApp("prd-artifact");
      const workflowId = "wf-prd";
      const artifactBody = "# PRD\n\nProduct Requirements.";

      const stateManager = new WorkflowStateManager(workspaceRoot);
      const artifactManager = new WorkflowArtifactManager(workspaceRoot, stateManager);
      await stateManager.create({ id: workflowId, type: "full_feature" });
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
      await stateManager.create({ id: workflowId, type: "full_feature" });
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
      await stateManager.create({ id: workflowId, type: "full_feature" });
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
      await stateManager.create({ id: workflowId, type: "full_feature" });
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
      await stateManager.create({ id: workflowId, type: "full_feature" });
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
      await stateManager.create({ id: workflowId, type: "full_feature" });
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
      await stateManager.create({ id: workflowId, type: "full_feature" });

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
          message: "Invalid artifact name: INVALID. Must be one of RESEARCH, PRD, SPEC, TASKS, HANDOFF_SUMMARY, INTERACTIONS, CRITIC_REPORT, EVIDENCE, FINAL_REPORT",
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
