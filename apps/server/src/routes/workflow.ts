import { Hono } from "hono";
import type { SpecraRuntime } from "@specra/agent-core";
import { WorkflowArtifactKindSchema, WorkflowStateManager } from "@specra/agent-core";
import { WorkflowArtifactManager } from "@specra/agent-core";
import {
  ArtifactNotFoundError,
  BadRequestError,
  WorkflowNotFoundError,
} from "../errors";
import { resolveProject } from "../resolve";

const SINGLE_FILE_ARTIFACT_PATHS: Partial<Record<string, string>> = {
  RESEARCH: "RESEARCH.md",
  PRD: "PRD.md",
  SPEC: "SPEC.md",
  TASKS: "TASKS.md",
  HANDOFF_SUMMARY: "HANDOFF_SUMMARY.md",
  INTERACTIONS: "INTERACTIONS.md",
  FINAL_REPORT: "FINAL_REPORT.md",
};

export function createWorkflowRoutes(runtime: SpecraRuntime): Hono {
  const app = new Hono();

  app.get("/:slug/workflows/:workflowId", async (c) => {
    const slug = c.req.param("slug");
    const workflowId = c.req.param("workflowId");

    if (!slug || !workflowId) {
      throw new BadRequestError("slug and workflowId are required");
    }

    const project = await resolveProject(runtime, slug);
    const stateManager = new WorkflowStateManager(project.workspaceRoot);

    try {
      const workflow = await stateManager.read(workflowId);
      return c.json({ workflow });
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new WorkflowNotFoundError(workflowId);
      }
      throw error;
    }
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
        `Invalid artifact name: ${name}. Must be one of ${WorkflowArtifactKindSchema.options.join(", ")}`,
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
