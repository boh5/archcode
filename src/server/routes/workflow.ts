import { join } from "node:path";
import { Hono } from "hono";
import type { SpecraRuntime } from "../../runtime";
import { WorkflowArtifactKindSchema, WorkflowStateManager } from "../../agents/workflow/state";
import { WorkflowArtifactManager } from "../../agents/workflow/artifacts";
import { getSessionsDir } from "../../store/sessions-dir";
import {
  ArtifactNotFoundError,
  BadRequestError,
  SessionNotFoundError,
  WorkflowNotFoundError,
} from "../errors";
import { resolveProject } from "../resolve";

const SINGLE_FILE_ARTIFACT_PATHS: Partial<Record<string, string>> = {
  PRD: "PRD.md",
  SPEC: "SPEC.md",
  TASKS: "TASKS.md",
  FINAL_REPORT: "FINAL_REPORT.md",
};

export function createWorkflowRoutes(runtime: SpecraRuntime): Hono {
  const app = new Hono();

  app.get("/:slug/sessions/:sessionId/workflow", async (c) => {
    const slug = c.req.param("slug");
    const sessionId = c.req.param("sessionId");

    if (!slug || !sessionId) {
      throw new BadRequestError("slug and sessionId are required");
    }

    const project = await resolveProject(runtime, slug);
    const workspaceRoot = project.workspaceRoot;

    const sessionFile = join(getSessionsDir(workspaceRoot), `${sessionId}.json`);
    if (!(await Bun.file(sessionFile).exists())) {
      throw new SessionNotFoundError(sessionId);
    }

    const stateManager = new WorkflowStateManager(workspaceRoot);
    const workflows = await stateManager.listWorkflows();

    for (const workflow of workflows) {
      const allSessionIds = [
        ...Object.values(workflow.sessionIds),
        ...Object.values(workflow.taskSessionIds),
      ];
      if (allSessionIds.includes(sessionId)) {
        return c.json({ workflow });
      }
    }

    return c.json({ workflow: null });
  });

  app.get("/:slug/workflows/:workflowId/artifacts/:name", async (c) => {
    const slug = c.req.param("slug");
    const workflowId = c.req.param("workflowId");
    const name = c.req.param("name");

    if (!slug || !workflowId || !name) {
      throw new BadRequestError("slug, workflowId, and name are required");
    }

    const parsed = WorkflowArtifactKindSchema.safeParse(name);
    if (!parsed.success) {
      throw new BadRequestError(
        `Invalid artifact name: ${name}. Must be one of PRD, SPEC, TASKS, CRITIC_REPORT, EVIDENCE, FINAL_REPORT`,
      );
    }
    const kind = parsed.data;

    const project = await resolveProject(runtime, slug);
    const workspaceRoot = project.workspaceRoot;

    const stateManager = new WorkflowStateManager(workspaceRoot);
    const artifactManager = new WorkflowArtifactManager(workspaceRoot, stateManager);

    let workflowState;
    try {
      workflowState = await stateManager.read(workflowId);
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new WorkflowNotFoundError(workflowId);
      }
      throw error;
    }

    let artifactPath: string | undefined;

    const singlePath = SINGLE_FILE_ARTIFACT_PATHS[kind];
    if (singlePath) {
      artifactPath = singlePath;
    } else {
      const paths = workflowState.artifacts[kind];
      if (!paths) {
        throw new ArtifactNotFoundError(name, workflowId);
      }
      artifactPath = Array.isArray(paths) ? paths[0] : paths;
    }

    try {
      const result = await artifactManager.read(workflowId, artifactPath);
      return c.json({ body: result.body });
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new ArtifactNotFoundError(name, workflowId);
      }
      throw error;
    }
  });

  return app;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
