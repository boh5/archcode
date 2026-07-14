import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import type { HitlRecord } from "@archcode/protocol";
import type { Agent } from "../agents/types";
import { runQueryLoop } from "../agents/query/loop";
import type { QueryLoopOptions } from "../agents/query/types";
import { GoalStateManager } from "../goals/state";
import { HitlService } from "../hitl/service";
import { ResumeCoordinator } from "../hitl/resume-coordinator";
import { setLlmAdapterForTest } from "../llm";
import { silentLogger } from "../logger";
import { MemoryFileManager } from "../memory/file-manager";
import { ProjectContextResolver } from "../projects/context-resolver";
import type { ProjectContext } from "../projects/types";
import type { ModelInfo } from "../provider/model";
import { SkillService } from "../skills";
import { SessionStoreManager } from "../store/session-store-manager";
import { getSessionHitlPath } from "../store/sessions-dir";
import { createTestTempRoot } from "../testing/test-temp-root";
import { createRegistry, defineTool } from "../tools";
import { ProjectApprovalManager } from "../tools/permission";
import { createTestProjectContext } from "../tools/test-project-context";
import { WorktreeService } from "../worktrees";
import { SessionExecutionScopeValidator } from "./session-execution-scope-validator";
import {
  readSessionHitlCheckpointFile,
} from "./session-hitl-checkpoint";
import type { SessionHitlResumeLease } from "./session-execution-manager";
import { SessionHitlResumeAdapter } from "./session-hitl-resume-adapter";

type StreamTextFn = typeof import("ai").streamText;

const testTempRoot = createTestTempRoot("session-hitl-resume-worktree");
const activeFixtures = new Set<Awaited<ReturnType<typeof createFixture>>>();
const testSkillService = new SkillService({ builtinSkills: {} });
const dummyModelInfo = {
  model: { modelId: "mock-model", provider: "mock-provider" },
  displayName: "Mock Model",
  limit: { context: 1000, output: 100 },
  modalities: { input: ["text"], output: ["text"] },
  providerId: "mock-provider",
  modelId: "mock-model",
  qualifiedId: "mock-provider:mock-model",
} as unknown as ModelInfo;

beforeEach(async () => {
  await testTempRoot.cleanup();
  await mkdir(testTempRoot.path, { recursive: true });
});

afterEach(async () => {
  for (const fixture of activeFixtures) {
    fixture.coordinator.dispose();
    await fixture.sessions.flushSession(fixture.sessionId, fixture.workspaceRoot);
    fixture.sessions.releaseWorkspace(fixture.workspaceRoot);
  }
  activeFixtures.clear();
  await testTempRoot.cleanup();
});

afterAll(async () => {
  setLlmAdapterForTest(undefined);
  await testTempRoot.cleanup();
});

describe("Session HITL resume worktree integration", () => {
  test("stores HITL checkpoints under the project root and resumes tools in Session cwd", async () => {
    const fixture = await createFixture();
    await initializeGitRepo(fixture.workspaceRoot);
    const worktreeCwd = (await new WorktreeService({ canonicalRoot: fixture.workspaceRoot }).create({
      owner: { type: "session", id: fixture.sessionId },
    })).worktreePath;
    await fixture.sessions.updateCwd(fixture.sessionId, fixture.workspaceRoot, worktreeCwd, fixture.workspaceRoot);
    let resumedCwd: string | undefined;
    const tool = defineTool({
      name: "cwd_guarded",
      description: "Capture resumed cwd",
      inputSchema: z.object({}).strict(),
      traits: { readOnly: false, destructive: true, concurrencySafe: false },
      permissions: [async () => ({ outcome: "ask", reason: "Approve cwd capture" })],
      execute: async (_input, ctx) => {
        resumedCwd = ctx.cwd;
        return "cwd captured";
      },
    });
    const registry = createRegistry([tool]);
    mockToolCallStream([{ toolCallId: "cwd-guarded-1", toolName: "cwd_guarded", input: {} }]);

    await runQueryLoop(
      { ...fixture.options(registry, ["cwd_guarded"]), cwd: worktreeCwd },
      "capture cwd",
    );
    const pending = await singlePendingHitl(fixture);

    expect(await Bun.file(join(worktreeCwd, ".archcode", "sessions", fixture.sessionId, "hitl-checkpoints.json")).exists()).toBe(false);
    expect((await readSessionHitlCheckpointFile(fixture.workspaceRoot, fixture.sessionId)).checkpoints).toHaveLength(1);

    await fixture.coordinator.respond(
      { owner: pending.owner, hitlId: pending.hitlId },
      { type: "permission_decision", decision: "approve_once" },
    );
    await waitFor(() => resumedCwd !== undefined);
    await waitFor(async () => {
      const found = await fixture.hitl.lookup({ owner: pending.owner, hitlId: pending.hitlId });
      return found.status === "found" && found.record.status === "resolved";
    });

    expect(resumedCwd).toBe(worktreeCwd);
  });
});

async function createFixture() {
  const workspaceRoot = join(testTempRoot.path, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const sessionId = crypto.randomUUID();
  const sessions = new SessionStoreManager({ logger: silentLogger });
  const store = sessions.create(sessionId, workspaceRoot, { agentName: "engineer" });
  const goalState = new GoalStateManager(workspaceRoot, silentLogger);
  const hitl = new HitlService({
    workspaceRoot,
    project: { slug: "archcode", name: "ArchCode" },
    sessions,
    goalState,
  });
  const approvals = new ProjectApprovalManager(silentLogger);
  await approvals.load(workspaceRoot);
  const projectContext: ProjectContext = {
    ...createTestProjectContext(workspaceRoot),
    project: { slug: "archcode", name: "ArchCode", workspaceRoot, addedAt: new Date().toISOString() },
    goalState,
    goalCancellation: { cancel: async (goalId, request) => await goalState.cancel(goalId, request.reason) },
    hitl,
    hitlResumeCoordinator: new ResumeCoordinator({ hitl, adapters: {} }),
    memory: new MemoryFileManager({
      project: join(workspaceRoot, ".archcode", "memory"),
      user: join(workspaceRoot, ".archcode", "user-memory"),
    }),
    approvals,
  };
  const resolver = createAliasedResolver(workspaceRoot, sessions, projectContext);
  const executionScopeValidator = new SessionExecutionScopeValidator({ projectContextResolver: resolver });
  let currentRegistry = createRegistry();
  const adapter = () => new SessionHitlResumeAdapter({
    workspaceRoot,
    storeManager: sessions,
    toolRegistry: currentRegistry,
    projectContextResolver: resolver,
    executionScopeValidator,
    skillService: testSkillService,
    reserveSessionHitlResume: () => createTestResumeLease(),
    getAgent: async () => noOpAgent(store),
  });
  const coordinator = new ResumeCoordinator({
    hitl,
    adapters: {
      session: {
        prepare: (record, response) => adapter().prepare(record, response),
        finalize: (record) => adapter().finalize(record),
      },
    },
  });
  projectContext.hitlResumeCoordinator = coordinator;

  const fixture = {
    workspaceRoot,
    sessionId,
    sessions,
    store,
    hitl,
    coordinator,
    options(registry: ReturnType<typeof createRegistry>, allowedTools: string[]): QueryLoopOptions {
      currentRegistry = registry;
      return {
        modelInfo: dummyModelInfo,
        logger: silentLogger,
        toolRegistry: registry,
        allowedTools,
        agentName: "engineer",
        agentSkills: [],
        skillService: testSkillService,
        storeManager: sessions,
        cwd: workspaceRoot,
        projectContext,
        store,
      };
    },
  };
  activeFixtures.add(fixture);
  return fixture;
}

function createAliasedResolver(
  workspaceRoot: string,
  sessions: SessionStoreManager,
  context: ProjectContext,
): ProjectContextResolver {
  const resolver = new ProjectContextResolver({
    projectInfoFactory: () => context.project,
    goalCancellationFactory: () => context.goalCancellation,
    goalRunnerFactory: () => ({}) as never,
    createAutomation: async () => { throw new Error("unused automation creator"); },
    sessionStoreManager: sessions,
    resumeCoordinatorFactory: () => context.hitlResumeCoordinator,
  });
  resolver.alias(workspaceRoot, context);
  return resolver;
}

function createTestResumeLease(): SessionHitlResumeLease {
  const abortController = new AbortController();
  return {
    generation: Symbol("test-session-hitl-resume"),
    abortSignal: abortController.signal,
    activate: () => undefined,
    acquireSessionCwdTransition: () => () => undefined,
    release: () => undefined,
  };
}

function noOpAgent(store: ReturnType<SessionStoreManager["create"]>): Agent {
  return {
    store,
    cwd: store.getState().cwd,
    run: async () => ({ text: "", steps: 0 }),
    dispose: () => undefined,
  } as Agent;
}

function mockToolCallStream(toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>) {
  const fn = mock(() => ({
    fullStream: (async function* () {
      for (const toolCall of toolCalls) yield { type: "tool-call" as const, ...toolCall };
    })(),
    finishReason: Promise.resolve("tool-calls"),
    usage: Promise.resolve({ totalTokens: 1 }),
    text: Promise.resolve(""),
    toolCalls: Promise.resolve(toolCalls),
  }));
  setLlmAdapterForTest({ streamText: fn as unknown as StreamTextFn });
}

async function singlePendingHitl(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<HitlRecord> {
  const file = await Bun.file(getSessionHitlPath(fixture.workspaceRoot, fixture.sessionId)).json() as {
    pending: HitlRecord[];
  };
  expect(file.pending).toHaveLength(1);
  return file.pending[0]!;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition was not met");
}

async function initializeGitRepo(workspaceRoot: string): Promise<void> {
  await git(workspaceRoot, ["init", "--initial-branch=main"]);
  await git(workspaceRoot, ["config", "user.email", "session-hitl@example.com"]);
  await git(workspaceRoot, ["config", "user.name", "Session HITL"]);
  await writeFile(join(workspaceRoot, "README.md"), "# Session HITL\n");
  await git(workspaceRoot, ["add", "README.md"]);
  await git(workspaceRoot, ["commit", "-m", "initial commit"]);
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(process.stderr).text();
  if (await process.exited !== 0) throw new Error(stderr);
}
