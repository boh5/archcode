import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AutomationSchedulerTimer, AutomationSchedulerTimerHandle } from "./automations/scheduler";
import { ServerConfigService, resolveServerConfigPath } from "./config";
import { setLlmAdapterForTest } from "./llm";
import { silentLogger } from "./logger";
import type { McpManager } from "./mcp";
import { ProjectRegistry } from "./projects/registry";
import { createRuntime, type AgentRuntime } from "./runtime";
import { createTestTempRoot } from "./testing/test-temp-root";
import { managedWorktreeNames, WorktreeService } from "./worktrees";

const testTempRoot = createTestTempRoot("runtime-automations-worktree");
const START = Date.parse("2026-07-13T00:00:00.000Z");
let activeRuntime: AgentRuntime | undefined;

beforeEach(async () => {
  await testTempRoot.cleanup();
  await mkdir(testTempRoot.path, { recursive: true });
  setLlmAdapterForTest({
    streamText: mock(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "Automation accepted." };
      })(),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ totalTokens: 1 }),
      text: Promise.resolve("Automation accepted."),
      toolCalls: Promise.resolve([]),
    })) as never,
    generateText: mock(async () => ({ text: "Automation session" })) as never,
  });
});

afterEach(async () => {
  activeRuntime?.notifyRuntimeShutdown("test cleanup");
  await activeRuntime?.abortAllSessionExecutions();
  await activeRuntime?.stopAutomationSchedulers();
  activeRuntime?.disposeAllSessionAgents();
  await activeRuntime?.mcpManager.closeAll();
  activeRuntime = undefined;
  setLlmAdapterForTest(undefined);
});

afterAll(async () => {
  await testTempRoot.cleanup();
});

describe("AgentRuntime Automation worktree wiring", () => {
  test("creates worktree Sessions through the shared WorktreeService", async () => {
    const fixture = await runtimeFixture();
    const automation = await fixture.runtime.createAutomation(fixture.workspaceRoot, {
      name: "isolated check",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Check in isolation", location: "worktree" },
      createdFromSessionId: fixture.sourceSessionId,
    });

    const invocation = await fixture.runtime.runAutomationNow(fixture.workspaceRoot, automation.id);
    const session = await fixture.runtime.getSessionFile(fixture.workspaceRoot, invocation.sessionId!);
    const worktree = await new WorktreeService({ canonicalRoot: fixture.workspaceRoot }).validate(session.cwd);

    expect(invocation.status).toBe("dispatched");
    expect(worktree.isManaged).toBe(true);
    expect(worktree.branchName).toBe(managedWorktreeNames({
      owner: { type: "session", id: invocation.sessionId! },
    }).branchName);
    await waitForInvocationExecution(fixture.runtime, fixture.workspaceRoot, invocation);
    await waitFor(async () => (
      (await fixture.runtime.getSessionFile(fixture.workspaceRoot, invocation.sessionId!)).title !== undefined
    ));
    await waitForPersistedTitle(fixture.workspaceRoot, invocation.sessionId!);
  });
});

async function runtimeFixture(): Promise<{
  runtime: AgentRuntime;
  workspaceRoot: string;
  sourceSessionId: string;
}> {
  const root = testTempRoot.path;
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await initializeGitRepo(workspaceRoot);
  const configPath = resolveServerConfigPath(root);
  await mkdir(join(root, ".archcode"), { recursive: true });
  await writeFile(configPath, JSON.stringify(config()));
  const registry = new ProjectRegistry({ homeDir: root, logger: silentLogger });
  await registry.add({ workspaceRoot, name: "Automation One" });
  const clock = new FakeClock(START);
  const runtime = await createRuntime({
    logger: silentLogger,
    configService: new ServerConfigService({ homeDir: root }),
    projectRegistryHomeDir: root,
    mcpManagerFactory: () => mcpManager(),
    automationSchedulerClock: clock,
    automationSchedulerTimer: new FakeTimer(clock),
  });
  activeRuntime = runtime;
  const sourceSession = await runtime.createSession(workspaceRoot, { agentName: "engineer" });
  return { runtime, workspaceRoot, sourceSessionId: sourceSession.sessionId };
}

function config(): Record<string, unknown> {
  return {
    provider: {
      local: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local",
        options: { baseURL: "http://localhost:8090/v1", apiKey: "test" },
        models: {
          test: {
            name: "Test",
            limit: { context: 128_000, output: 8_192 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
    agents: {
      engineer: { model: "local:test" },
      goal_lead: { model: "local:test" },
      plan: { model: "local:test" },
      build: { model: "local:test" },
      reviewer: { model: "local:test" },
      explore: { model: "local:test" },
      librarian: { model: "local:test" },
    },
    mcp: { servers: {} },
  };
}

function mcpManager(): McpManager {
  return {
    discover: mock(async () => ({ descriptors: [], warnings: [] })),
    closeAll: mock(async () => []),
    getStatus: mock(() => new Map()),
    onStatusChange: mock(() => () => {}),
    startBackgroundDiscovery: mock(() => {}),
  } as unknown as McpManager;
}

async function initializeGitRepo(cwd: string): Promise<void> {
  await git(cwd, ["init", "--initial-branch=main"]);
  await git(cwd, ["config", "user.email", "automation@example.com"]);
  await git(cwd, ["config", "user.name", "Automation Test"]);
  await writeFile(join(cwd, "README.md"), "# Automation\n");
  await git(cwd, ["add", "README.md"]);
  await git(cwd, ["commit", "-m", "initial"]);
}

async function git(cwd: string, args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(stderr);
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for runtime state");
}

async function waitForInvocationExecution(
  runtime: AgentRuntime,
  workspaceRoot: string,
  invocation: { readonly automationId: string; readonly executionId: string; readonly sessionId?: string },
): Promise<void> {
  let dispatched = invocation;
  await waitFor(async () => {
    const current = (await runtime.listAutomationInvocations(workspaceRoot, invocation.automationId))
      .find((candidate) => candidate.executionId === invocation.executionId);
    if (current?.status === "failed") throw new Error(current.error ?? "Automation Invocation failed");
    if (current?.status !== "dispatched") return false;
    dispatched = current;
    return true;
  });
  if (dispatched.sessionId === undefined) throw new Error("Invocation did not allocate a Session");
  await waitFor(async () => {
    const session = await runtime.getSessionFile(workspaceRoot, dispatched.sessionId!);
    return session.executions.some((execution) => (
      execution.id === invocation.executionId && execution.status !== "running"
    ));
  });
}

async function waitForPersistedTitle(workspaceRoot: string, sessionId: string): Promise<void> {
  const path = join(workspaceRoot, ".archcode", "sessions", sessionId, "session.json");
  await waitFor(async () => {
    if (!await Bun.file(path).exists()) return false;
    const session = await Bun.file(path).json() as { title?: string | null };
    return session.title !== undefined && session.title !== null;
  });
}

class FakeClock {
  constructor(private value: number) {}

  now(): number {
    return this.value;
  }

  set(value: number): void {
    this.value = value;
  }
}

class FakeTimer implements AutomationSchedulerTimer {
  readonly #tasks = new Map<number, { dueAt: number; callback: () => void | Promise<void> }>();
  #nextId = 1;

  constructor(private readonly clock: FakeClock) {}

  schedule(delayMs: number, callback: () => void | Promise<void>): AutomationSchedulerTimerHandle {
    const id = this.#nextId++;
    this.#tasks.set(id, { dueAt: this.clock.now() + delayMs, callback });
    return { id };
  }

  cancel(handle: AutomationSchedulerTimerHandle): void {
    if (typeof handle.id === "number") this.#tasks.delete(handle.id);
  }
}
