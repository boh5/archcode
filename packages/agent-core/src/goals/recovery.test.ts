import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DoneCondition } from "@archcode/protocol";

import { createRuntime } from "../runtime";
import { silentLogger } from "../logger";
import { GoalStateManager } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-recovery-runtime");

const condition: DoneCondition = {
  id: "artifact-exists",
  kind: "file_exists",
  params: { path: "artifact.txt" },
};

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("runtime Goal recovery", () => {
  test("createRuntime recovers interrupted goals for all registered projects", async () => {
    const homeDir = await mkdtemp(join(TMP_ROOT, "home-"));
    const workspaceA = await mkdtemp(join(TMP_ROOT, "workspace-a-"));
    const workspaceB = await mkdtemp(join(TMP_ROOT, "workspace-b-"));
    await writeConfig(workspaceA);
    await writeProjectRegistry(homeDir, [
      { slug: "project-a", name: "Project A", workspaceRoot: workspaceA, addedAt: new Date().toISOString() },
      { slug: "project-b", name: "Project B", workspaceRoot: workspaceB, addedAt: new Date().toISOString() },
    ]);

    const managerA = new GoalStateManager(workspaceA);
    const managerB = new GoalStateManager(workspaceB);
    const goalA = await createRunningGoal(managerA, "project-a", "Goal A");
    const goalB = await createRunningGoal(managerB, "project-b", "Goal B");

    await createRuntime({
      configPath: join(workspaceA, ".archcode.json"),
      projectRegistryHomeDir: homeDir,
      mcpManagerFactory: () => mockMcpManager(),
      logger: silentLogger,
    });

    expect((await managerA.read(goalA.id)).status).toBe("failed");
    expect((await managerA.read(goalA.id)).lastError).toContain("Interrupted");
    expect((await managerB.read(goalB.id)).status).toBe("failed");
    expect((await managerB.read(goalB.id)).lastError).toContain("Interrupted");
  });
});

async function createRunningGoal(manager: GoalStateManager, projectId: string, title: string) {
  const goal = await manager.create(projectId, title, "architect", [condition]);
  await manager.lock(goal.id, "architect");
  await manager.transitionStatus(goal.id, "running");
  return manager.updateSessionIds(goal.id, `${projectId}-missing-session`, []);
}

async function writeProjectRegistry(homeDir: string, projects: Array<{ slug: string; name: string; workspaceRoot: string; addedAt: string }>): Promise<void> {
  const registryPath = join(homeDir, ".archcode", "projects", "index.json");
  await mkdir(join(homeDir, ".archcode", "projects"), { recursive: true });
  await writeFile(registryPath, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`);
}

async function writeConfig(workspaceRoot: string): Promise<void> {
  await writeFile(join(workspaceRoot, ".archcode.json"), JSON.stringify({
    provider: {
      local: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local LLM",
        options: { baseURL: "http://localhost:8090/v1", apiKey: "test-key" },
        models: {
          "test-model": {
            name: "Test Model",
            limit: { context: 128000, output: 8192 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
    agents: {
      orchestrator: { model: "local:test-model" },
      plan: { model: "local:test-model" },
      build: { model: "local:test-model" },
      reviewer: { model: "local:test-model" },
      explore: { model: "local:test-model" },
      librarian: { model: "local:test-model" },
    },
  }));
}

function mockMcpManager() {
  return {
    discover: mock(async () => ({ descriptors: [], warnings: [] })),
    closeAll: mock(async () => []),
    getStatus: mock(() => new Map()),
    onStatusChange: mock(() => () => {}),
    startBackgroundDiscovery: mock(() => {}),
  } as never;
}
