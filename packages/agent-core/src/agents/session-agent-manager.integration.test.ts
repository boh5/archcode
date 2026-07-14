import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import type { ArchCodeConfig } from "../config/schema";
import { silentLogger } from "../logger";
import type { ProviderRegistry } from "../provider";
import { ModelInfo } from "../provider/model";
import { SkillService } from "../skills";
import { SessionStoreManager } from "../store/session-store-manager";
import { createTestTempRoot } from "../testing/test-temp-root";
import { createRegistry } from "../tools/registry";
import type { AnyToolDescriptor } from "../tools/types";
import { engineerAgentDefinition } from "./definitions";
import { SessionAgentManager } from "./session-agent-manager";
import { createTestProjectContextResolver } from "./test-project-context-resolver";

const testTempRoot = createTestTempRoot("session-agent-manager");

afterAll(async () => {
  await testTempRoot.cleanup();
});

describe("SessionAgentManager Git cwd validation", () => {
  test("rejects a persisted Session cwd outside the project repository", async () => {
    const root = join(testTempRoot.path, "invalid-cwd");
    const projectRoot = join(root, "project");
    const outside = join(root, "outside");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await gitInit(projectRoot);
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    storeManager.create(sessionId, projectRoot, { cwd: outside, agentName: "engineer" });
    const manager = createManager(storeManager);

    await expect(manager.getOrCreate(projectRoot, sessionId)).rejects.toMatchObject({
      name: "InvalidSessionCwdError",
      cwd: outside,
    });
  });

  test("rejects the canonical checkout through a different persisted path spelling", async () => {
    const root = join(testTempRoot.path, "canonical-cwd-alias");
    const realProjectRoot = join(root, "project-real");
    const projectRoot = join(root, "project-alias");
    await mkdir(realProjectRoot, { recursive: true });
    await gitInit(realProjectRoot);
    await symlink(realProjectRoot, projectRoot, "dir");
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    storeManager.create(sessionId, projectRoot, { cwd: realProjectRoot, agentName: "engineer" });
    const manager = createManager(storeManager);

    await expect(manager.getOrCreate(projectRoot, sessionId)).rejects.toMatchObject({
      name: "InvalidSessionCwdError",
      cwd: realProjectRoot,
    });
  });
});

function createManager(storeManager: SessionStoreManager): SessionAgentManager {
  const providerRegistry = makeProviderRegistry();
  return new SessionAgentManager({
    definitions: [engineerAgentDefinition],
    providerRegistry,
    toolRegistry: createRegistry([makeTool("unknown_tool")]),
    skillService: new SkillService({ builtinSkills: {} }),
    storeManager,
    projectContextResolver: createTestProjectContextResolver(storeManager),
    config: {
      provider: {},
      agents: { engineer: { model: providerRegistry.modelIds[0]! } },
    } as unknown as ArchCodeConfig,
    logger: silentLogger,
    maxConcurrentSessions: 4,
  });
}

function makeTool(name: string): AnyToolDescriptor {
  return {
    name,
    description: `${name} tool`,
    inputSchema: z.object({}).strict(),
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: () => `${name} result`,
  };
}

function makeProviderRegistry(): ProviderRegistry {
  const model = new ModelInfo({
    model: {} as ConstructorParameters<typeof ModelInfo>[0]["model"],
    config: {
      name: "Test Model",
      limit: { context: 128_000, output: 8_192 },
      modalities: { input: ["text"], output: ["text"] },
    },
    providerId: "test",
    modelId: "model",
  });
  return {
    sdkRegistry: {} as ProviderRegistry["sdkRegistry"],
    models: new Map([[model.qualifiedId, model]]),
    modelIds: [model.qualifiedId],
    getModel: () => model,
  } as ProviderRegistry;
}

async function gitInit(cwd: string): Promise<void> {
  const process = Bun.spawn(["git", "init", "--initial-branch=main"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(process.stderr).text();
  if (await process.exited !== 0) throw new Error(stderr);
}
