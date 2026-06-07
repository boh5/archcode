import { Hono } from "hono";
import type { SpecraRuntime } from "@specra/agent-core";
import {
  ArtifactPathError,
  SingleFileWorkflowArtifactKindSchema,
  VALID_ARTIFACT_KIND_LIST,
  WorkflowArtifactKindSchema,
  WorkflowInvalidIdError,
  WorkflowStateManager,
} from "@specra/agent-core";
import { WorkflowArtifactManager } from "@specra/agent-core";
import {
  ArtifactNotFoundError,
  BadRequestError,
  WorkflowNotFoundError,
} from "../errors";
import { resolveProject } from "../resolve";

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
      if (error instanceof WorkflowInvalidIdError) {
        throw new BadRequestError(error.message);
      }
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
        `Invalid artifact name: ${name}. Must be one of ${VALID_ARTIFACT_KIND_LIST}`,
      );
    }
    const result = await readRouteArtifact(runtime, {
      slug,
      workflowId,
      kind: parsed.data,
      path: c.req.query("path"),
      fallbackName: name,
    });

    return c.json({ body: result.body });
  });

  app.get("/:slug/workflows/:workflowId/artifacts", async (c) => {
    const slug = c.req.param("slug");
    const workflowId = c.req.param("workflowId");
    const path = c.req.query("path");
    const kindInput = c.req.query("kind");

    if (!slug || !workflowId) {
      throw new BadRequestError("slug and workflowId are required");
    }

    const kind = kindInput ? parseArtifactKind(kindInput) : undefined;
    if (!kind && !path) {
      throw new BadRequestError("Either kind or path query parameter is required");
    }

    const result = await readRouteArtifact(runtime, {
      slug,
      workflowId,
      kind,
      path,
      fallbackName: path ?? kind ?? "artifact",
    });

    return c.json({ body: result.body });
  });

  return app;
}

async function readRouteArtifact(
  runtime: SpecraRuntime,
  input: {
    slug: string;
    workflowId: string;
    kind?: (typeof WorkflowArtifactKindSchema.options)[number];
    path?: string;
    fallbackName: string;
  },
) {
  const project = await resolveProject(runtime, input.slug);
  const workspaceRoot = project.workspaceRoot;

  const stateManager = new WorkflowStateManager(workspaceRoot);
  const artifactManager = new WorkflowArtifactManager(workspaceRoot, stateManager);

  let workflowState;
  try {
    workflowState = await stateManager.read(input.workflowId);
  } catch (error) {
    if (error instanceof WorkflowInvalidIdError) {
      throw new BadRequestError(error.message);
    }
    if (isMissingFileError(error)) {
      throw new WorkflowNotFoundError(input.workflowId);
    }
    throw error;
  }

  try {
    return input.path
      ? await artifactManager.read(input.workflowId, input.path)
      : await readArtifactByRouteKind({
          artifactManager,
          workflowId: input.workflowId,
          kind: input.kind as (typeof WorkflowArtifactKindSchema.options)[number],
          workflowState,
        });
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new ArtifactNotFoundError(input.path ?? input.fallbackName, input.workflowId);
    }
    if (error instanceof ArtifactPathError) {
      throw new BadRequestError(error.message);
    }
    throw error;
  }
}

function parseArtifactKind(name: string): (typeof WorkflowArtifactKindSchema.options)[number] {
  const parsed = WorkflowArtifactKindSchema.safeParse(name);
  if (!parsed.success) {
    throw new BadRequestError(
      `Invalid artifact name: ${name}. Must be one of ${VALID_ARTIFACT_KIND_LIST}`,
    );
  }
  return parsed.data;
}

async function readArtifactByRouteKind({
  artifactManager,
  workflowId,
  kind,
  workflowState,
}: {
  artifactManager: WorkflowArtifactManager;
  workflowId: string;
  kind: (typeof WorkflowArtifactKindSchema.options)[number];
  workflowState: Awaited<ReturnType<WorkflowStateManager["read"]>>;
}) {
  const singleKind = SingleFileWorkflowArtifactKindSchema.safeParse(kind);
  if (singleKind.success) {
    return await artifactManager.readByKind(workflowId, singleKind.data);
  }

  const paths = workflowState.artifacts[kind];
  if (!paths) {
    throw new ArtifactNotFoundError(kind, workflowId);
  }

  return await artifactManager.read(workflowId, Array.isArray(paths) ? paths[0] : paths);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
