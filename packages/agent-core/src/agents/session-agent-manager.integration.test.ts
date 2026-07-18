import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { silentLogger } from "../logger";
import { SkillService } from "../skills";
import { SessionStoreManager } from "../store/session-store-manager";
import { createTestTempRoot } from "../testing/test-temp-root";
import type { ToolRegistry } from "../tools/registry";
import type { AnyToolDescriptor } from "../tools/types";
import { createTextToolResult } from "../tools/results";
import { createTestToolRegistryFixture, type TestToolRegistryFixture } from "../tools/test-registry";
import { engineerAgentDefinition } from "./definitions";
import { SessionAgentManager } from "./session-agent-manager";
import { createTestProjectContextResolver } from "./test-project-context-resolver";

const testTempRoot = createTestTempRoot("session-agent-manager");
const registryFixtures: TestToolRegistryFixture[] = [];
const outputAccessFixture = createTestToolRegistryFixture();

function createTestRegistry(descriptors: AnyToolDescriptor[]): ToolRegistry {
  const fixture = createTestToolRegistryFixture({ descriptors });
  registryFixtures.push(fixture);
  return fixture.registry;
}

afterAll(async () => {
  await Promise.all([...registryFixtures, outputAccessFixture].map((fixture) => fixture.dispose()));
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
  return new SessionAgentManager({
    definitions: [engineerAgentDefinition],
    toolRegistry: createTestRegistry([makeTool("unknown_tool")]),
    skillService: new SkillService({ builtinSkills: {} }),
    storeManager,
    createToolOutputAccess: outputAccessFixture.createToolOutputAccess,
    projectContextResolver: createTestProjectContextResolver(storeManager),
    logger: silentLogger,
  });
}

function makeTool(name: string): AnyToolDescriptor {
  return {
    name,
    description: `${name} tool`,
    inputSchema: z.object({}).strict(),
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
    execute: () => createTextToolResult(`${name} result`),
  };
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
