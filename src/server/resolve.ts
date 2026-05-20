import { stat } from "node:fs/promises";

import type { SpecraRuntime } from "../runtime";
import type { ProjectInfo } from "../projects/types";
import { ProjectNotFoundError, WorkspaceNotFoundError } from "./errors";

export async function resolveProject(
  runtime: SpecraRuntime,
  slug: string,
): Promise<ProjectInfo> {
  const project = await runtime.projectRegistry.get(slug);
  if (!project) {
    throw new ProjectNotFoundError(slug);
  }

  try {
    const s = await stat(project.workspaceRoot);
    if (!s.isDirectory()) {
      throw new WorkspaceNotFoundError(
        `Project workspace is not a directory: ${project.workspaceRoot}`,
      );
    }
  } catch (error) {
    if (error instanceof WorkspaceNotFoundError) throw error;
    throw new WorkspaceNotFoundError(
      `Project workspace does not exist: ${project.workspaceRoot}`,
    );
  }

  return project;
}
