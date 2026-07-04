import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { SkillService } from "../skills";
import { createSessionStore } from "../store/store";
import { SessionStoreManager } from "../store/session-store-manager";
import { createRegistry } from "../tools/registry";
import { createToolExecutionContext, type AnyToolDescriptor, type ToolExecutionContext } from "../tools/types";
import { ProjectContextResolver } from "../projects/context-resolver";
import { silentLogger } from "../logger";
import { TOOL_BASH, TOOL_FILE_EDIT, TOOL_FILE_WRITE } from "../tools/names";
import { CollisionLedger } from "./collision-ledger";
import { createLoopCollisionToolPermission } from "./collision-tool-guard";
import { createDefaultToolTargetExtractorRegistry } from "./tool-target-extractors";
import { LoopStateManager, type LoopConfig } from "./state";
import { FakeClock } from "./test-utils";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "collision-tool-guard");
const storeManager = new SessionStoreManager({ logger: silentLogger });

const config: LoopConfig = {
  title: "Guarded collision loop",
  schedule: { kind: "manual" },
  runKind: "session",
  mode: "act",
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 4, softThresholdRatio: 0.8, hardThresholdRatio: 1 },
};

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("createLoopCollisionToolPermission", () => {
  test("file write target conflict returns structured collision_conflict error before execution", async () => {
    const fixture = await createFixture();
    const holder = await fixture.stateManager.create("project-a", config);
    const contender = await fixture.stateManager.create("project-a", config);
    await fixture.ledger.acquire({ target: { type: "file", path: "src/app.ts" }, loopId: holder.loopId, runId: "run-a", priority: 10, expiresAt: Date.now() + 60_000 });

    const result = await fixture.registry.execute(
      { toolCallId: "write-1", toolName: TOOL_FILE_WRITE, input: { path: "./src/../src/app.ts", content: "export {};" } },
      fixture.context(TOOL_FILE_WRITE, contender.loopId, "run-b"),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("LOOP_COLLISION_CONFLICT");
    expect(result.output).toContain("collision_conflict");
    expect(fixture.executedTools).toEqual([]);
    const conflicts = await fixture.ledger.readConflicts();
    expect(conflicts.at(-1)).toMatchObject({ targetKey: "file:src/app.ts" });
  });

  test("file edit target conflict uses structured path input", async () => {
    const fixture = await createFixture();
    const holder = await fixture.stateManager.create("project-a", config);
    const contender = await fixture.stateManager.create("project-a", config);
    await fixture.ledger.acquire({ target: { type: "file", path: "src/edit.ts" }, loopId: holder.loopId, runId: "run-a", priority: 10, expiresAt: Date.now() + 60_000 });

    const result = await fixture.registry.execute(
      { toolCallId: "edit-1", toolName: TOOL_FILE_EDIT, input: { path: "src/edit.ts", edits: [{ oldString: "a", newString: "b" }] } },
      fixture.context(TOOL_FILE_EDIT, contender.loopId, "run-b"),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("file:src/edit.ts");
    expect(fixture.executedTools).toEqual([]);
  });

  test("bash input is never parsed for collision targets", async () => {
    const fixture = await createFixture();
    const holder = await fixture.stateManager.create("project-a", config);
    const contender = await fixture.stateManager.create("project-a", config);
    await fixture.ledger.acquire({ target: { type: "file", path: "src/app.ts" }, loopId: holder.loopId, runId: "run-a", priority: 10, expiresAt: Date.now() + 60_000 });

    const result = await fixture.registry.execute(
      { toolCallId: "bash-1", toolName: TOOL_BASH, input: { command: "cat > src/app.ts" } },
      fixture.context(TOOL_BASH, contender.loopId, "run-b"),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toBe("executed-bash");
    expect(fixture.executedTools).toEqual([TOOL_BASH]);
  });

  test("future GitHub structured PR extractor conflicts without connector tools", async () => {
    const registry = createDefaultToolTargetExtractorRegistry();
    const targets = registry.extract("github_create_issue_comment", {
      owner: "archcode",
      repo: "archcode",
      issueNumber: 42,
      body: "Looks good",
    }, { workspaceRoot: TMP_DIR });

    expect(targets).toEqual([{ type: "issue", owner: "archcode", repo: "archcode", number: 42 }]);
  });
});

async function createFixture() {
  const clock = new FakeClock(Date.UTC(2026, 6, 4, 12, 0, 0));
  const stateManager = new LoopStateManager(TMP_DIR);
  const resolver = new ProjectContextResolver({ projectInfoFactory: () => ({ slug: "project-a", name: "Project A", workspaceRoot: TMP_DIR, addedAt: "2026-07-04T00:00:00.000Z" }) });
  const projectContext = await resolver.resolve(TMP_DIR);
  const executedTools: string[] = [];
  const registry = createRegistry(makeToolDescriptors(executedTools));
  registry.globalPermissions.push(createLoopCollisionToolPermission({ leaseTtlMs: 60_000 }));
  const ledger = new CollisionLedger({ stateManager, workspaceRoot: TMP_DIR, clock, leaseTtlMs: 60_000 });
  const store = createSessionStore("session-1");

  function context(toolName: string, loopId: string, runId: string): ToolExecutionContext {
    store.setState({ loopId });
    return createToolExecutionContext({
      store,
      storeManager,
      toolName,
      toolCallId: `${toolName}-call`,
      input: {},
      step: 0,
      abort: new AbortController().signal,
      startedAt: clock.now(),
      allowedTools: new Set([toolName]),
      projectContext,
      agentSkills: [],
      skillService: new SkillService({ builtinSkills: {} }),
      origin: { kind: "loop", loopId, runId, trigger: "manual", mode: "act", approvalPolicy: "interactive" },
    });
  }

  return { clock, stateManager, registry, ledger, context, executedTools };
}

function makeToolDescriptors(executedTools: string[]): AnyToolDescriptor[] {
  return [
    {
      name: TOOL_FILE_WRITE,
      description: "test file write",
      inputSchema: z.object({ path: z.string(), content: z.string() }).strict(),
      traits: { readOnly: false, destructive: false, concurrencySafe: false },
      execute: async () => {
        executedTools.push(TOOL_FILE_WRITE);
        return { output: "executed-write", isError: false };
      },
    },
    {
      name: TOOL_FILE_EDIT,
      description: "test file edit",
      inputSchema: z.object({ path: z.string(), edits: z.array(z.object({ oldString: z.string(), newString: z.string() }).strict()).min(1) }).strict(),
      traits: { readOnly: false, destructive: false, concurrencySafe: false },
      execute: async () => {
        executedTools.push(TOOL_FILE_EDIT);
        return { output: "executed-edit", isError: false };
      },
    },
    {
      name: TOOL_BASH,
      description: "test bash",
      inputSchema: z.object({ command: z.string() }).strict(),
      traits: { readOnly: false, destructive: true, concurrencySafe: false },
      permissions: [() => ({ outcome: "allow" })],
      execute: async () => {
        executedTools.push(TOOL_BASH);
        return { output: "executed-bash", isError: false };
      },
    },
  ];
}
