import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import type { ProjectInfo } from "../projects/types";
import { ProjectNotFoundError, WorkspaceNotFoundError } from "./errors";
import { resolveProject } from "./resolve";

const TMP = join(import.meta.dir, "__test_tmp__");

function makeRuntime(projects: ProjectInfo[]) {
  return {
    projectRegistry: {
      get: async (slug: string) => projects.find((p) => p.slug === slug),
    },
  } as any;
}

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true }).catch(() => undefined);
});

describe("resolveProject", () => {
  test("throws ProjectNotFoundError when slug is not registered", async () => {
    const runtime = makeRuntime([]);

    try {
      await resolveProject(runtime, "nonexistent");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectNotFoundError);
      expect((error as ProjectNotFoundError).code).toBe("PROJECT_NOT_FOUND");
      expect((error as ProjectNotFoundError).httpStatus).toBe(404);
    }
  });

  test("throws WorkspaceNotFoundError when directory does not exist", async () => {
    const runtime = makeRuntime([
      { slug: "gone", name: "Gone", workspaceRoot: join(TMP, "deleted-project"), addedAt: new Date().toISOString() },
    ]);

    try {
      await resolveProject(runtime, "gone");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceNotFoundError);
      expect((error as WorkspaceNotFoundError).code).toBe("WORKSPACE_NOT_FOUND");
      expect((error as WorkspaceNotFoundError).httpStatus).toBe(410);
    }
  });

  test("throws WorkspaceNotFoundError when path is not a directory", async () => {
    await mkdir(TMP, { recursive: true });
    const filePath = join(TMP, "not-a-dir");
    await Bun.write(filePath, "file");

    const runtime = makeRuntime([
      { slug: "file-project", name: "File", workspaceRoot: filePath, addedAt: new Date().toISOString() },
    ]);

    try {
      await resolveProject(runtime, "file-project");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceNotFoundError);
      expect((error as WorkspaceNotFoundError).code).toBe("WORKSPACE_NOT_FOUND");
    }
  });

  test("returns ProjectInfo when workspace directory exists", async () => {
    const dir = join(TMP, "exists");
    await mkdir(dir, { recursive: true });

    const project: ProjectInfo = {
      slug: "exists",
      name: "Exists",
      workspaceRoot: dir,
      addedAt: new Date().toISOString(),
    };
    const runtime = makeRuntime([project]);

    const result = await resolveProject(runtime, "exists");
    expect(result).toEqual(project);
  });
});