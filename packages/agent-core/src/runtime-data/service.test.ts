import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { silentLogger } from "../logger";
import { ServerConfigService, resolveServerConfigPath } from "../config";
import { ProjectRegistry } from "../projects/registry";
import { projectRuntimePath } from "../projects/runtime-path";
import type { ProjectInfo } from "../projects/types";
import { createRuntime } from "../runtime";
import { SessionStoreManager } from "../store/session-store-manager";
import { createTestMcpRuntime } from "../testing/test-mcp-runtime";
import {
  RuntimeDataRequestError,
  RuntimeDataService,
  type RuntimeDataProjectRegistry,
} from "./service";

const TMP_ROOT = join(tmpdir(), "archcode-runtime-data", crypto.randomUUID());
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SECRET = "persisted-secret-value";

class TestProjectRegistry implements RuntimeDataProjectRegistry {
  projects: ProjectInfo[] = [];

  async list(): Promise<ProjectInfo[]> {
    return this.projects.map((project) => ({ ...project }));
  }
}

const registry = new TestProjectRegistry();
const service = new RuntimeDataService({ projectRegistry: registry });

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  registry.projects = [];
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("RuntimeDataService inspection", () => {
  test("uses every current domain schema for valid, missing, invalid JSON, schema mismatch, and unreadable files", async () => {
    const targets = [
      { name: "session", relativePath: `sessions/${SESSION_ID}/session.json` },
      { name: "todo", relativePath: "todos/state.json" },
      { name: "automation", relativePath: "automations/state.json" },
      { name: "hitl", relativePath: "hitl-queue.json" },
      { name: "permissions", relativePath: "permissions.json" },
    ] as const;
    const cases = ["valid", "missing", "invalid_json", "invalid_current_schema", "unreadable"] as const;

    for (const target of targets) {
      for (const fixtureCase of cases) {
        const project = await createProject(`${target.name}-${fixtureCase}`);
        const targetPath = join(projectRuntimePath(project.workspaceRoot), target.relativePath);
        const sentinelPath = join(TMP_ROOT, `${target.name}-${fixtureCase}-sentinel.json`);

        switch (fixtureCase) {
          case "valid":
            break;
          case "missing":
            await rm(
              target.name === "session" ? join(targetPath, "..") : targetPath,
              { recursive: target.name === "session" },
            );
            break;
          case "invalid_json":
            await writeFile(targetPath, `{${SECRET}`);
            break;
          case "invalid_current_schema":
            await writeFile(targetPath, JSON.stringify({ unexpected: SECRET }));
            break;
          case "unreadable":
            await writeFile(sentinelPath, `{${SECRET}`);
            await rm(targetPath);
            await symlink(sentinelPath, targetPath);
            break;
        }

        registry.projects = [project];
        const response = await service.inspect();
        const inspected = response.projects[0]!;
        const targetIssues = inspected.issues.filter((issue) => issue.relativePath === target.relativePath);

        if (fixtureCase === "valid" || fixtureCase === "missing") {
          expect(targetIssues).toEqual([]);
        } else {
          expect(targetIssues).toHaveLength(1);
          expect(targetIssues[0]?.reason).toBe(fixtureCase);
        }
        if (fixtureCase === "invalid_current_schema") {
          expect(targetIssues[0]?.schemaIssues?.length).toBeGreaterThan(0);
          expect(targetIssues[0]?.schemaIssues?.[0]?.message).toBe(
            "Does not match the current ArchCode data format.",
          );
        }
        expect(JSON.stringify(response)).not.toContain(SECRET);
      }
    }
  });

  test("isolates unreadable projects and preserves complete reports and stats for others", async () => {
    const unreadable = await createProject("unreadable-project");
    const healthy = await createProject("healthy-project");
    const outside = join(TMP_ROOT, "outside-runtime");
    await mkdir(outside);
    await writeFile(join(outside, "sentinel.txt"), SECRET);
    await rm(projectRuntimePath(unreadable.workspaceRoot), { recursive: true });
    await symlink(outside, projectRuntimePath(unreadable.workspaceRoot));

    registry.projects = [unreadable, healthy];
    const response = await service.inspect();

    expect(response.projects).toHaveLength(2);
    expect(response.projects[0]).toMatchObject({
      projectSlug: unreadable.slug,
      stats: { fileCount: 0, totalBytes: 0 },
      issues: [{ relativePath: ".", reason: "unreadable" }],
    });
    expect(response.projects[1]?.projectSlug).toBe(healthy.slug);
    expect(response.projects[1]?.issues).toEqual([]);
    expect(response.projects[1]?.stats.fileCount).toBe(5);
    expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe(SECRET);
    expect(JSON.stringify(response)).not.toContain(SECRET);
  });

  test("treats missing .archcode or Runtime directories as an empty healthy state", async () => {
    const project = await createProject("missing-runtime-root");
    const statePath = join(project.workspaceRoot, ".archcode");
    registry.projects = [project];

    await rm(statePath, { recursive: true });
    expect((await service.inspect()).projects[0]).toMatchObject({
      stats: { fileCount: 0, totalBytes: 0 },
      issues: [],
    });

    await mkdir(statePath);
    expect((await service.inspect()).projects[0]).toMatchObject({
      stats: { fileCount: 0, totalBytes: 0 },
      issues: [],
    });
  });

  test("does not follow a .archcode ancestor symlink into an outside sentinel", async () => {
    const project = await createProject("state-ancestor-symlink");
    const statePath = join(project.workspaceRoot, ".archcode");
    const outsideStatePath = join(TMP_ROOT, "outside-state-target");
    await rename(statePath, outsideStatePath);
    const sentinelPath = join(outsideStatePath, "runtime", "todos", "state.json");
    await writeFile(sentinelPath, JSON.stringify({ [SECRET]: SECRET }));
    const sentinelBefore = await readFile(sentinelPath, "utf8");
    await symlink(outsideStatePath, statePath);
    registry.projects = [project];

    const response = await service.inspect();

    expect(response.projects[0]).toMatchObject({
      stats: { fileCount: 0, totalBytes: 0 },
      issues: [{ relativePath: ".", reason: "unreadable" }],
    });
    expect(JSON.stringify(response)).not.toContain(SECRET);
    expect(await readFile(sentinelPath, "utf8")).toBe(sentinelBefore);
  });

  test("redacts secret-bearing dynamic keys from schema issue paths", async () => {
    const project = await createProject("secret-schema-key");
    const sessionPath = join(
      projectRuntimePath(project.workspaceRoot),
      "sessions",
      SESSION_ID,
      "session.json",
    );
    const session = JSON.parse(await readFile(sessionPath, "utf8")) as {
      compression: { refMap: { messageRefsById: Record<string, unknown> } };
    };
    const secretKey = `dynamic-${SECRET}-key`;
    session.compression.refMap.messageRefsById = { [secretKey]: "not-a-message-ref" };
    await writeFile(sessionPath, JSON.stringify(session));
    registry.projects = [project];

    const response = await service.inspect();
    const issue = response.projects[0]?.issues.find(
      (candidate) => candidate.relativePath === `sessions/${SESSION_ID}/session.json`,
    );

    expect(issue?.reason).toBe("invalid_current_schema");
    expect(issue?.schemaIssues?.some((schemaIssue) => (
      schemaIssue.path.includes("$field")
    ))).toBe(true);
    expect(JSON.stringify(response)).not.toContain(secretKey);
    expect(JSON.stringify(response)).not.toContain(SECRET);
  });

  test("never follows Session directory, session.json, or traversal symlinks", async () => {
    const project = await createProject("symlink-project");
    const runtimePath = projectRuntimePath(project.workspaceRoot);
    const outside = join(TMP_ROOT, "outside");
    await mkdir(outside, { recursive: true });
    const sentinel = join(outside, "sentinel.json");
    await writeFile(sentinel, `{${SECRET}`);

    const linkedSessionDirectory = join(runtimePath, "sessions", "linked-session");
    await symlink(outside, linkedSessionDirectory);
    const sessionFile = join(runtimePath, "sessions", SESSION_ID, "session.json");
    await rm(sessionFile);
    await symlink(sentinel, sessionFile);
    await mkdir(join(runtimePath, "attachments"), { recursive: true });
    await symlink(outside, join(runtimePath, "attachments", "linked-tree"));

    registry.projects = [project];
    const response = await service.inspect();
    const issues = response.projects[0]!.issues;

    expect(issues).toEqual(expect.arrayContaining([
      { relativePath: "sessions/linked-session", reason: "unreadable" },
      { relativePath: `sessions/${SESSION_ID}/session.json`, reason: "unreadable" },
      { relativePath: "attachments/linked-tree", reason: "unreadable" },
    ]));
    expect(issues.some((issue) => issue.reason === "invalid_json")).toBe(false);
    expect(await readFile(sentinel, "utf8")).toBe(`{${SECRET}`);
  });

  test("reports an orphan Session directory whose required session.json is missing", async () => {
    const project = await createProject("orphan-session");
    const orphanPath = join(projectRuntimePath(project.workspaceRoot), "sessions", "orphan");
    await mkdir(orphanPath);
    registry.projects = [project];

    const response = await service.inspect();

    expect(response.projects[0]?.issues).toContainEqual({
      relativePath: "sessions/orphan/session.json",
      reason: "unreadable",
    });
  });

  test("keeps runtime activation errors outside the data inspection DTO", async () => {
    const startupFailureProject = await createProject("startup-failure");
    const unrelatedProject = await createProject("unrelated-invalid-todo");
    await writeFile(
      join(projectRuntimePath(startupFailureProject.workspaceRoot), "sessions", SESSION_ID, "session.json"),
      JSON.stringify({ invalidSession: true }),
    );
    await writeFile(
      join(projectRuntimePath(unrelatedProject.workspaceRoot), "todos", "state.json"),
      JSON.stringify({ invalidTodo: true }),
    );
    registry.projects = [startupFailureProject, unrelatedProject];

    const response = await service.inspect();

    expect(response.projects[0]?.issues[0]).toMatchObject({
      relativePath: `sessions/${SESSION_ID}/session.json`,
      reason: "invalid_current_schema",
    });
    expect(response.projects[1]?.issues[0]).toMatchObject({
      relativePath: "todos/state.json",
      reason: "invalid_current_schema",
    });
    expect(response).not.toHaveProperty("runtimeError");
    expect(JSON.stringify(response)).not.toMatch(/startupCause|old version|new version/i);
  });

  test("bounds oversized JSON reads and the per-project issue response", async () => {
    const project = await createProject("bounded-inspection");
    const runtimePath = projectRuntimePath(project.workspaceRoot);
    const sessionsPath = join(runtimePath, "sessions");
    for (let index = 0; index < 105; index += 1) {
      const sessionPath = join(sessionsPath, `broken-${String(index).padStart(3, "0")}`);
      await mkdir(sessionPath);
      await writeFile(join(sessionPath, "session.json"), "{");
    }
    await truncate(join(runtimePath, "todos", "state.json"), 64 * 1024 * 1024 + 1);
    registry.projects = [project];

    const response = await service.inspect();
    const issues = response.projects[0]!.issues;

    expect(issues).toHaveLength(100);
    expect(issues).toContainEqual({ relativePath: "todos/state.json", reason: "inspection_limit" });
  });
});

describe("RuntimeDataService deletion", () => {
  test("allows a structurally safe Runtime tree whose JSON exceeds the inspection limit", async () => {
    const project = await createProject("oversized-json");
    const runtimePath = projectRuntimePath(project.workspaceRoot);
    await truncate(join(runtimePath, "todos", "state.json"), 64 * 1024 * 1024 + 1);
    registry.projects = [project];

    expect((await service.inspect()).projects[0]?.issues).toContainEqual({
      relativePath: "todos/state.json",
      reason: "inspection_limit",
    });
    expect(await service.delete([project.slug])).toEqual({
      results: [{ projectSlug: project.slug, status: "deleted" }],
    });
    await expect(lstat(runtimePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects empty, duplicate, unknown, and healthy selections before mutation", async () => {
    const invalid = await createProject("invalid");
    const healthy = await createProject("healthy");
    const marker = join(projectRuntimePath(invalid.workspaceRoot), "todos", "state.json");
    await writeFile(marker, "{");
    registry.projects = [invalid, healthy];

    const requests: Array<{
      slugs: string[];
      code: RuntimeDataRequestError["code"];
    }> = [
      { slugs: [], code: "EMPTY_PROJECT_SLUGS" },
      { slugs: [invalid.slug, invalid.slug], code: "DUPLICATE_PROJECT_SLUG" },
      { slugs: ["not-registered"], code: "PROJECT_NOT_REGISTERED" },
      { slugs: [invalid.slug, healthy.slug], code: "PROJECT_HAS_NO_ISSUES" },
    ];
    for (const request of requests) {
      await expectRuntimeDataError(service.delete(request.slugs), request.code);
      expect(await readFile(marker, "utf8")).toBe("{");
      expect(await lstat(projectRuntimePath(healthy.workspaceRoot))).toBeDefined();
    }
  });

  test("deletes only complete selected Runtime trees and preserves every outside boundary", async () => {
    const selected = await createProject("selected");
    const unselected = await createProject("unselected");
    const selectedRuntime = projectRuntimePath(selected.workspaceRoot);
    const unselectedRuntime = projectRuntimePath(unselected.workspaceRoot);
    await writeFile(join(selectedRuntime, "todos", "state.json"), "{");
    await mkdir(join(selectedRuntime, "attachments", "sessions"), { recursive: true });
    await writeFile(join(selectedRuntime, "attachments", "sessions", "payload.bin"), "payload");

    const preserved = [
      join(selected.workspaceRoot, "source.ts"),
      join(selected.workspaceRoot, ".git", "HEAD"),
      join(selected.workspaceRoot, ".archcode", "plans", "plan.md"),
      join(selected.workspaceRoot, ".archcode", "skills", "skill.md"),
    ];
    for (const path of preserved) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, `preserved:${path}`);
    }
    const unselectedBefore = await readFile(join(unselectedRuntime, "todos", "state.json"));
    registry.projects = [selected, unselected];

    const response = await service.delete([selected.slug]);

    expect(response).toEqual({ results: [{ projectSlug: selected.slug, status: "deleted" }] });
    await expect(lstat(selectedRuntime)).rejects.toMatchObject({ code: "ENOENT" });
    for (const path of preserved) {
      expect(await readFile(path, "utf8")).toBe(`preserved:${path}`);
    }
    expect(await readFile(join(unselectedRuntime, "todos", "state.json"))).toEqual(unselectedBefore);
    expect((await registry.list()).map((project) => project.slug)).toEqual([selected.slug, unselected.slug]);
  });

  test("fails closed for workspace, state, Runtime, descendant symlinks, abnormal targets, and lexical escape", async () => {
    const fixtures: Array<{
      name: string;
      arrange(project: ProjectInfo): Promise<ProjectInfo>;
    }> = [
      {
        name: "workspace-symlink",
        async arrange(project) {
          await writeFile(join(projectRuntimePath(project.workspaceRoot), "todos", "state.json"), "{");
          const link = join(TMP_ROOT, "workspace-link");
          await symlink(project.workspaceRoot, link);
          return { ...project, slug: "workspace-symlink", workspaceRoot: link };
        },
      },
      {
        name: "state-symlink",
        async arrange(project) {
          const state = join(project.workspaceRoot, ".archcode");
          const moved = join(project.workspaceRoot, "state-target");
          await rm(join(projectRuntimePath(project.workspaceRoot), "todos", "state.json"));
          await writeFile(join(projectRuntimePath(project.workspaceRoot), "todos", "state.json"), "{");
          await rename(state, moved);
          await symlink(moved, state);
          return project;
        },
      },
      {
        name: "runtime-symlink",
        async arrange(project) {
          const runtime = projectRuntimePath(project.workspaceRoot);
          const moved = join(project.workspaceRoot, "runtime-target");
          await rm(join(runtime, "todos", "state.json"));
          await writeFile(join(runtime, "todos", "state.json"), "{");
          await rename(runtime, moved);
          await symlink(moved, runtime);
          return project;
        },
      },
      {
        name: "descendant-symlink",
        async arrange(project) {
          const runtime = projectRuntimePath(project.workspaceRoot);
          await writeFile(join(runtime, "todos", "state.json"), "{");
          await symlink(TMP_ROOT, join(runtime, "linked"));
          return project;
        },
      },
      {
        name: "runtime-file",
        async arrange(project) {
          const runtime = projectRuntimePath(project.workspaceRoot);
          await rm(runtime, { recursive: true });
          await writeFile(runtime, "{");
          return project;
        },
      },
      {
        name: "lexical-escape",
        async arrange(project) {
          await writeFile(join(projectRuntimePath(project.workspaceRoot), "todos", "state.json"), "{");
          return {
            ...project,
            slug: "lexical-escape",
            workspaceRoot: `${project.workspaceRoot}/child/..`,
          };
        },
      },
    ];

    for (const fixture of fixtures) {
      const original = await createProject(fixture.name);
      const project = await fixture.arrange(original);
      registry.projects = [project];
      const sentinel = join(original.workspaceRoot, "sentinel.txt");
      await writeFile(sentinel, SECRET);

      await expectRuntimeDataError(service.delete([project.slug]), "DELETE_TARGET_UNSAFE");

      expect(await readFile(sentinel, "utf8")).toBe(SECRET);
    }
  });

  test.skipIf(typeof process.getuid === "function" && process.getuid() === 0)("returns per-project deletion errors and leaves retry admission to the Host", async () => {
    const first = await createProject("first");
    const second = await createProject("second");
    await writeFile(join(projectRuntimePath(first.workspaceRoot), "todos", "state.json"), "{");
    await writeFile(join(projectRuntimePath(second.workspaceRoot), "todos", "state.json"), "{");
    registry.projects = [first, second];

    const secondStatePath = join(second.workspaceRoot, ".archcode");
    await chmod(secondStatePath, 0o500);
    try {
      const response = await service.delete([first.slug, second.slug]);
      expect(response.results[0]).toEqual({ projectSlug: first.slug, status: "deleted" });
      expect(response.results[1]).toEqual({
        projectSlug: second.slug,
        status: "error",
        error: { code: "delete_failed", message: "Runtime data could not be deleted." },
      });
      await expect(lstat(projectRuntimePath(first.workspaceRoot))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await lstat(projectRuntimePath(second.workspaceRoot))).toBeDefined();
    } finally {
      await chmod(secondStatePath, 0o700);
    }
  });
});

describe("Runtime Project Registry ownership", () => {
  test("createRuntime reuses the process-owned registry injected by the control plane", async () => {
    const homeDir = join(TMP_ROOT, "shared-registry-home");
    const configPath = resolveServerConfigPath(homeDir);
    await mkdir(join(configPath, ".."), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      provider: {
        local: {
          npm: "@ai-sdk/openai-compatible",
          name: "Local",
          options: { baseURL: "http://localhost:8090/v1", apiKey: "test-key" },
          models: {
            test: {
              name: "Test",
              limit: { context: 128_000, output: 8_192 },
              modalities: { input: ["text"], output: ["text"] },
            },
          },
        },
      },
      profiles: {
        principal: { model: "local:test" },
        deep: { model: "local:test" },
        fast: { model: "local:test" },
      },
    }));
    const configService = new ServerConfigService({ homeDir });
    const activation = await configService.activateForStartup();
    if (activation.status !== "ready") throw new Error("Expected a valid test Config");
    const processRegistry = new ProjectRegistry({ homeDir, logger: silentLogger });
    const fakeMcpRuntime = createTestMcpRuntime();

    const runtime = await createRuntime({
      configService,
      activation: activation.activation,
      projectRegistry: processRegistry,
      runtimeStorageHomeDir: join(TMP_ROOT, "runtime-storage"),
      mcpRuntimeFactory: () => fakeMcpRuntime,
    });
    try {
      expect(runtime.projectRegistry).toBe(processRegistry);
    } finally {
      await runtime.shutdown();
    }
  });
});

async function createProject(slug: string): Promise<ProjectInfo> {
  const workspaceRoot = join(TMP_ROOT, slug);
  await mkdir(workspaceRoot, { recursive: true });
  const project: ProjectInfo = {
    slug,
    name: slug,
    workspaceRoot,
    addedAt: "2026-08-04T00:00:00.000Z",
  };
  await writeValidRuntime(project);
  return project;
}

async function writeValidRuntime(project: ProjectInfo): Promise<void> {
  const manager = new SessionStoreManager({ logger: silentLogger });
  await manager.createSessionFile(project.workspaceRoot, {
    agentName: "lead",
    source: { kind: "direct" },
  }, SESSION_ID);
  const runtimePath = projectRuntimePath(project.workspaceRoot);
  await mkdir(join(runtimePath, "todos"), { recursive: true });
  await mkdir(join(runtimePath, "automations"), { recursive: true });
  await writeFile(join(runtimePath, "todos", "state.json"), JSON.stringify({
    todos: [],
    runNowReceipts: [],
  }));
  await writeFile(join(runtimePath, "automations", "state.json"), JSON.stringify({
    automations: [],
    invocations: [],
  }));
  await writeFile(join(runtimePath, "hitl-queue.json"), JSON.stringify({
    records: [],
    updatedAt: "2026-08-04T00:00:00.000Z",
  }));
  await writeFile(join(runtimePath, "permissions.json"), JSON.stringify({ approvals: [] }));
}

async function expectRuntimeDataError(
  operation: Promise<unknown>,
  code: RuntimeDataRequestError["code"],
): Promise<void> {
  try {
    await operation;
    throw new Error(`Expected RuntimeDataRequestError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeDataRequestError);
    expect((error as RuntimeDataRequestError).code).toBe(code);
  }
}
