import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProcessRunner, type AgentRuntime } from "@archcode/agent-core";
import { ProjectRegistry, silentLogger } from "@archcode/agent-core";
import { createServerApp } from "../app";
import { parseUnifiedDiff, type DiffFile } from "./files";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "files-routes");
const isolatedTemp = resolve(tmpdir(), "archcode-test-files-routes");

interface DiffResponseBody {
  files: DiffFile[];
}

function createTestRuntime(projectRegistry: ProjectRegistry): AgentRuntime {
  return {
    projectRegistry,
    mcpManager: undefined,
    toolRegistry: undefined,
    skillService: undefined,
    providerRegistry: undefined,
    warnings: [],
    contextResolver: undefined,
    createSession: async () => ({ sessionId: "session", title: null, createdAt: Date.now(), messages: [], steps: [], todos: [], reminders: [] }),
    getSessionFile: async (_workspaceRoot: string, sessionId: string) => ({ sessionId, title: null, createdAt: Date.now(), messages: [], steps: [], todos: [], reminders: [] }),
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
    deleteSession: async () => undefined,
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
  } as unknown as AgentRuntime;
}

async function createTestApp(testName: string) {
  const homeDir = join(tempRoot, "homes", testName);
  await mkdir(homeDir, { recursive: true });
  const projectRegistry = new ProjectRegistry({ homeDir, logger: silentLogger });
  const runtime = createTestRuntime(projectRegistry);
  const workspaceRoot = join(tempRoot, "workspaces", testName);
  await initGitRepo(workspaceRoot);
  const project = await projectRegistry.add({ workspaceRoot, name: testName });

  return {
    app: createServerApp(runtime, { dev: true }).app,
    project,
    workspaceRoot,
  };
}

async function initGitRepo(workspaceRoot: string): Promise<void> {
  await mkdir(workspaceRoot, { recursive: true });
  await run(workspaceRoot, ["git", "init"]);
  await run(workspaceRoot, ["git", "config", "user.email", "archcode@example.test"]);
  await run(workspaceRoot, ["git", "config", "user.name", "ArchCode Test"]);
  await Bun.write(join(workspaceRoot, "README.md"), "# Test Repo\n");
  await run(workspaceRoot, ["git", "add", "README.md"]);
  await run(workspaceRoot, ["git", "commit", "-m", "initial"]);
}

async function run(cwd: string, command: string[]): Promise<void> {
  const result = await createProcessRunner().run({
    argv: command as [string, ...string[]],
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.kind !== "success") {
    const message = result.kind === "nonzero"
      ? result.output.stderr.trim() || `exit code ${result.exitCode}`
      : result.kind === "spawn-failure"
        ? result.error.message
        : result.kind === "timeout"
          ? `timed out after ${result.timeoutMs}ms`
          : result.kind === "aborted"
            ? "aborted"
            : `terminated by signal ${result.signal}`;
    throw new Error(`${command.join(" ")} failed: ${message}`);
  }
}

function fileByPath(files: DiffFile[], path: string): DiffFile {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`Expected diff file ${path}`);
  return file;
}

describe("files routes", () => {
  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("parseUnifiedDiff parses modified, created, deleted, and binary files", () => {
    const files = parseUnifiedDiff(`diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 const x = 1;
-const z = 3;
+const y = 2;
 export { x };
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const n = 1;
+export const m = 2;
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const old = true;
-export const gone = true;
diff --git a/assets/logo.png b/assets/logo.png
index 1234567..7654321 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`);

    expect(fileByPath(files, "src/foo.ts")).toEqual({
      path: "src/foo.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      hunks: [
        {
          header: "@@ -1,3 +1,4 @@",
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 4,
          lines: [
            { type: "context", content: "const x = 1;" },
            { type: "delete", content: "const z = 3;" },
            { type: "add", content: "const y = 2;" },
            { type: "context", content: "export { x };" },
          ],
        },
      ],
    });
    expect(fileByPath(files, "src/new.ts")).toMatchObject({
      status: "created",
      additions: 2,
      deletions: 0,
    });
    expect(fileByPath(files, "src/old.ts")).toMatchObject({
      status: "deleted",
      additions: 0,
      deletions: 2,
    });
    expect(fileByPath(files, "assets/logo.png")).toEqual({
      path: "assets/logo.png",
      status: "modified",
      additions: 0,
      deletions: 0,
      hunks: [],
    });
  });

  test("GET /api/projects/:slug/diff returns empty files for a clean workspace", async () => {
    const { app, project } = await createTestApp("clean-workspace");

    const res = await app.request(`/api/projects/${project.slug}/diff`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: [] });
  });

  test("GET /api/projects/:slug/diff returns tracked and untracked workspace changes", async () => {
    const { app, project, workspaceRoot } = await createTestApp("workspace-changes");
    await Bun.write(join(workspaceRoot, "README.md"), "# Test Repo\n\nAdded line\n");
    await Bun.write(join(workspaceRoot, "created.txt"), "created but staged\n");
    await Bun.write(join(workspaceRoot, "untracked.txt"), "untracked content\n");
    await run(workspaceRoot, ["git", "add", "created.txt"]);

    const res = await app.request(`/api/projects/${project.slug}/diff`);
    const body = (await res.json()) as DiffResponseBody;

    expect(res.status).toBe(200);
    expect(fileByPath(body.files, "README.md")).toMatchObject({
      status: "modified",
      additions: 2,
      deletions: 0,
    });
    expect(fileByPath(body.files, "created.txt")).toMatchObject({
      status: "created",
      additions: 1,
      deletions: 0,
    });
    expect(fileByPath(body.files, "untracked.txt")).toEqual({
      path: "untracked.txt",
      status: "created",
      additions: 0,
      deletions: 0,
      hunks: [],
    });
  });

  test("GET /api/projects/:slug/diff returns deleted files", async () => {
    const { app, project, workspaceRoot } = await createTestApp("deleted-file");
    await rm(join(workspaceRoot, "README.md"));

    const res = await app.request(`/api/projects/${project.slug}/diff`);
    const body = (await res.json()) as DiffResponseBody;

    expect(res.status).toBe(200);
    expect(fileByPath(body.files, "README.md")).toMatchObject({
      status: "deleted",
      additions: 0,
      deletions: 1,
    });
  });

  test("GET /api/projects/:slug/diff returns empty files for non-git workspace", async () => {
    const workspaceRoot = join(isolatedTemp, "no-git-workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const homeDir = join(isolatedTemp, "homes", "no-git-workspace");
    await mkdir(homeDir, { recursive: true });
    const projectRegistry = new ProjectRegistry({ homeDir, logger: silentLogger });
    const runtime = createTestRuntime(projectRegistry);
    // Create workspace directory WITHOUT git init
    const project = await projectRegistry.add({ workspaceRoot, name: "no-git-workspace" });
    const app = createServerApp(runtime, { dev: true }).app;

    const res = await app.request(`/api/projects/${project.slug}/diff`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: [] });
    await rm(isolatedTemp, { recursive: true, force: true });
  });

  test("GET /api/projects/:slug/diff for non-existent project slug returns 404", async () => {
    const { app } = await createTestApp("missing-project");

    const res = await app.request("/api/projects/missing/diff");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "PROJECT_NOT_FOUND", message: "Project not found: missing" },
    });
  });
});
