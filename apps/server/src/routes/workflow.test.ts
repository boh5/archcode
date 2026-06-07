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

      const stateManager = new WorkflowStateManager(workspaceRoot);
      const workflow = await stateManager.create({ title: "wf-1", type: "full_feature",
        sessionIds: { orchestrator: "session-1" },
      });

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/${workflow.id}`,
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.workflow).toBeDefined();
      expect(body.workflow.id).toBe(workflow.id);
      expect(body.workflow.sessionIds).toEqual({ orchestrator: "session-1" });
    });

    test("returns 404 for non-existent workflow", async () => {
      const { app, project } = await createTestApp("workflow-not-found");
      const workflowId = "550e8400-e29b-41d4-a716-446655440123";

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

        const stateManager = new WorkflowStateManager(workspaceRoot);
        const artifactManager = new WorkflowArtifactManager(workspaceRoot, stateManager);
        const workflow = await stateManager.create({ title: `wf-${artifact.kind.toLowerCase()}`, type: "full_feature" });
        await artifactManager.write({
          workflowId: workflow.id,
          kind: artifact.kind,
          path: `${artifact.kind}.md`,
          frontmatter: { version: "1" },
          content: artifact.body,
        });

        const res = await app.request(
          `/api/projects/${project.slug}/workflows/${workflow.id}/artifacts/${artifact.kind}`,
        );

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ body: artifact.body });
      });
    }

    test("returns PRD artifact body", async () => {
      const { app, project, workspaceRoot } = await createTestApp("prd-artifact");
      const artifactBody = "# PRD\n\nProduct Requirements.";

      const stateManager = new WorkflowStateManager(workspaceRoot);
      const artifactManager = new WorkflowArtifactManager(workspaceRoot, stateManager);
      const workflow = await stateManager.create({ title: "wf-prd", type: "full_feature" });
      await artifactManager.write({
        workflowId: workflow.id,
        kind: "PRD",
        path: "PRD.md",
        frontmatter: { owner: "product" },
        content: artifactBody,
      });

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/${workflow.id}/artifacts/PRD`,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ body: artifactBody });
    });

    test("returns SPEC artifact body", async () => {
      const { app, project, workspaceRoot } = await createTestApp("spec-artifact");
      const artifactBody = "# SPEC\n\nTechnical spec.";

      const stateManager = new WorkflowStateManager(workspaceRoot);
      const artifactManager = new WorkflowArtifactManager(workspaceRoot, stateManager);
      const workflow = await stateManager.create({ title: "wf-spec", type: "full_feature" });
      await artifactManager.write({
        workflowId: workflow.id,
        kind: "SPEC",
        path: "SPEC.md",
        frontmatter: { version: "1" },
        content: artifactBody,
      });

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/${workflow.id}/artifacts/SPEC`,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ body: artifactBody });
    });

    test("returns TASKS artifact body", async () => {
      const { app, project, workspaceRoot } = await createTestApp("tasks-artifact");
      const artifactBody = "# Tasks\n\n- Task 1";

      const stateManager = new WorkflowStateManager(workspaceRoot);
      const artifactManager = new WorkflowArtifactManager(workspaceRoot, stateManager);
      const workflow = await stateManager.create({ title: "wf-tasks", type: "full_feature" });
      await artifactManager.write({
        workflowId: workflow.id,
        kind: "TASKS",
        path: "TASKS.md",
        frontmatter: { version: "1" },
        content: artifactBody,
      });

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/${workflow.id}/artifacts/TASKS`,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ body: artifactBody });
    });

    test("returns FINAL_REPORT artifact body", async () => {
      const { app, project, workspaceRoot } = await createTestApp("final-report-artifact");
      const artifactBody = "# Final Report\n\nAll done.";

      const stateManager = new WorkflowStateManager(workspaceRoot);
      const artifactManager = new WorkflowArtifactManager(workspaceRoot, stateManager);
      const workflow = await stateManager.create({ title: "wf-final", type: "full_feature" });
      await artifactManager.write({
        workflowId: workflow.id,
        kind: "FINAL_REPORT",
        path: "FINAL_REPORT.md",
        frontmatter: { version: "1" },
        content: artifactBody,
      });

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/${workflow.id}/artifacts/FINAL_REPORT`,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ body: artifactBody });
    });

    test("returns CRITIC_REPORT artifact body from workflow state", async () => {
      const { app, project, workspaceRoot } = await createTestApp("critic-artifact");
      const artifactBody = "## Review\n\nLooks good.";

      const stateManager = new WorkflowStateManager(workspaceRoot);
      const artifactManager = new WorkflowArtifactManager(workspaceRoot, stateManager);
      const workflow = await stateManager.create({ title: "wf-critic", type: "full_feature" });
      await artifactManager.write({
        workflowId: workflow.id,
        kind: "CRITIC_REPORT",
        path: "critic-reports/prd.md",
        frontmatter: { reviewer: "critic" },
        content: artifactBody,
      });

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/${workflow.id}/artifacts/CRITIC_REPORT`,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ body: artifactBody });
    });

    test("returns EVIDENCE artifact body from workflow state", async () => {
      const { app, project, workspaceRoot } = await createTestApp("evidence-artifact");
      const artifactBody = "Test output evidence";

      const stateManager = new WorkflowStateManager(workspaceRoot);
      const artifactManager = new WorkflowArtifactManager(workspaceRoot, stateManager);
      const workflow = await stateManager.create({ title: "wf-evidence", type: "full_feature" });
      await artifactManager.write({
        workflowId: workflow.id,
        kind: "EVIDENCE",
        path: "evidence/test-output.txt",
        frontmatter: { source: "test" },
        content: artifactBody,
      });

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/${workflow.id}/artifacts/EVIDENCE`,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ body: artifactBody });
    });

    test("returns explicit multi-file group artifact by path query", async () => {
      const { app, project, workspaceRoot } = await createTestApp("artifact-path-query");

      const stateManager = new WorkflowStateManager(workspaceRoot);
      const artifactManager = new WorkflowArtifactManager(workspaceRoot, stateManager);
      const workflow = await stateManager.create({ title: "wf-path-query", type: "full_feature" });
      await artifactManager.write({
        workflowId: workflow.id,
        kind: "EVIDENCE",
        path: "evidence/first.txt",
        content: "first",
      });
      await artifactManager.write({
        workflowId: workflow.id,
        kind: "EVIDENCE",
        path: "evidence/second.txt",
        content: "second",
      });

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/${workflow.id}/artifacts/EVIDENCE?path=${encodeURIComponent("evidence/second.txt")}`,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ body: "second" });
    });

    test("returns supporting notes through path-based artifact route", async () => {
      const { app, project, workspaceRoot } = await createTestApp("artifact-notes-query");

      const stateManager = new WorkflowStateManager(workspaceRoot);
      const artifactManager = new WorkflowArtifactManager(workspaceRoot, stateManager);
      const workflow = await stateManager.create({ title: "wf-notes-query", type: "full_feature" });
      await artifactManager.write({
        workflowId: workflow.id,
        path: "notes/intermediate.md",
        content: "scratch notes",
      });

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/${workflow.id}/artifacts?path=${encodeURIComponent("notes/intermediate.md")}`,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ body: "scratch notes" });
    });

    test("returns same-project cross-workflow artifact reads", async () => {
      const { app, project, workspaceRoot } = await createTestApp("artifact-cross-workflow");
      const stateManager = new WorkflowStateManager(workspaceRoot);
      const artifactManager = new WorkflowArtifactManager(workspaceRoot, stateManager);
      const wfOtherWf = await stateManager.create({ title: "wf-other", type: "full_feature" });
      await artifactManager.write({
        workflowId: wfOtherWf.id,
        kind: "PRD",
        path: "PRD.md",
        frontmatter: { kind: "PRD" },
        content: "# Other PRD\n",
      });

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/${wfOtherWf.id}/artifacts?kind=PRD`,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ body: "# Other PRD\n" });
    });

    test("rejects path traversal artifact reads", async () => {
      const { app, project, workspaceRoot } = await createTestApp("artifact-traversal");
      const stateManager = new WorkflowStateManager(workspaceRoot);
      const workflow = await stateManager.create({ title: "wf-traversal", type: "full_feature" });

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/${workflow.id}/artifacts?path=${encodeURIComponent("../outside.md")}`,
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toContain(`Invalid artifact path for workflow ${workflow.id}`);
    });

    test("rejects cross-project artifact reads by project slug isolation", async () => {
      const first = await createTestApp("artifact-cross-project-a");
      const secondWorkspace = await makeWorkspace("artifact-cross-project-b");
      const secondProject = await first.projectRegistry.add({
        workspaceRoot: secondWorkspace,
        name: "artifact-cross-project-b",
      });

      const secondState = new WorkflowStateManager(secondWorkspace);
      const secondArtifacts = new WorkflowArtifactManager(secondWorkspace, secondState);
      const foreignWf = await secondState.create({ title: "wf-foreign", type: "full_feature" });
      await secondArtifacts.write({
        workflowId: foreignWf.id,
        kind: "PRD",
        path: "PRD.md",
        frontmatter: { kind: "PRD" },
        content: "foreign",
      });

      const res = await first.app.request(
        `/api/projects/${first.project.slug}/workflows/${foreignWf.id}/artifacts?kind=PRD`,
      );
      const foreignRes = await first.app.request(
        `/api/projects/${secondProject.slug}/workflows/${foreignWf.id}/artifacts?kind=PRD`,
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: "WORKFLOW_NOT_FOUND", message: `Workflow not found: ${foreignWf.id}` },
      });
      expect(foreignRes.status).toBe(200);
      expect(await foreignRes.json()).toEqual({ body: "foreign" });
    });

    test("returns 404 for non-existent workflow", async () => {
      const { app, project } = await createTestApp("missing-workflow-artifact");
      const workflowId = "550e8400-e29b-41d4-a716-446655440124";

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

      const stateManager = new WorkflowStateManager(workspaceRoot);
      const workflow = await stateManager.create({ title: "wf-no-artifact", type: "full_feature" });

      const res = await app.request(
        `/api/projects/${project.slug}/workflows/${workflow.id}/artifacts/PRD`,
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: "ARTIFACT_NOT_FOUND", message: `Artifact not found: PRD in workflow ${workflow.id}` },
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
