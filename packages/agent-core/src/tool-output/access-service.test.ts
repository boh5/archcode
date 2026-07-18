import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScopeBoundToolOutputAccess, type ToolOutputAccessService } from "./access-service";
import { ToolOutputArtifactStore, computeProjectIdentity } from "./artifact-store";
import { createTestArtifact } from "./artifact-store-fixture.test";
import { ToolOutputError } from "./errors";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ScopeBoundToolOutputAccess", () => {
  test("binds authorization and never accepts caller-supplied scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "archcode-output-access-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot);
    const store = new ToolOutputArtifactStore({ rootDir: join(root, "artifacts") });
    await store.ready();
    const created = await createTestArtifact(store, {
      owner: {
        projectIdentity: await computeProjectIdentity(workspaceRoot),
        rootSessionId: "family-a",
        producerSessionId: "child-a",
      },
      canonical: "recoverable output",
    });

    const allowed = createScopeBoundToolOutputAccess(store, {
      workspaceRoot,
      rootSessionId: "family-a",
    });
    expect((await allowed.read({ outputRef: created.outputRef })).records[0]?.text).toBe("recoverable output");
    expect(await allowed.countRecoverable()).toBe(1);

    const denied = createScopeBoundToolOutputAccess(store, {
      workspaceRoot,
      rootSessionId: "family-b",
    });
    await expect(denied.read({ outputRef: created.outputRef })).rejects.toMatchObject({
      code: "TOOL_OUTPUT_FORBIDDEN",
    } satisfies Partial<ToolOutputError>);
    await store.dispose();
  });

  test("service contract exposes only bounded read and search", () => {
    type Keys = keyof ToolOutputAccessService;
    const keys: Record<Keys, true> = { countRecoverable: true, read: true, search: true };
    expect(Object.keys(keys).sort()).toEqual(["countRecoverable", "read", "search"]);
  });
});
