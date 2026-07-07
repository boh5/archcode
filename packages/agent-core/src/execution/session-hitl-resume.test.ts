import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import type { HitlRecord } from "@archcode/protocol";
import { GoalArtifactManager } from "../goals/artifacts";
import { GoalMemoryManager } from "../goals/goal-memory";
import { GoalStateManager } from "../goals/state";
import { HitlService } from "../hitl/service";
import { ResumeCoordinator } from "../hitl/resume-coordinator";
import { LoopStateManager } from "../loops/state";
import { setLlmAdapterForTest } from "../llm";
import type { Agent } from "../agents/types";
import { MemoryFileManager } from "../memory/file-manager";
import { ProjectContextResolver } from "../projects/context-resolver";
import type { ProjectContext } from "../projects/types";
import type { ModelInfo } from "../provider/model";
import { SessionStoreManager } from "../store/session-store-manager";
import { getSessionHitlPath } from "../store/sessions-dir";
import { createRegistry, defineTool } from "../tools";
import { askUserTool } from "../tools/builtins";
import { ProjectApprovalManager } from "../tools/permission";
import { SkillService } from "../skills";
import { silentLogger } from "../logger";
import { runQueryLoop } from "../agents/query/loop";
import type { QueryLoopOptions } from "../agents/query/types";
import { SessionHitlResumeAdapter } from "./session-hitl-resume-adapter";
import { readSessionHitlCheckpointFile, writeSessionHitlCheckpoint } from "./session-hitl-checkpoint";

type StreamTextFn = typeof import("ai").streamText;

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "session-hitl-resume");
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

describe("Session HITL resume", () => {
  beforeEach(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
    await mkdir(TMP_ROOT, { recursive: true });
  });

  afterAll(async () => {
    setLlmAdapterForTest(undefined);
    await rm(TMP_ROOT, { recursive: true, force: true });
  });

  test("ask_user creates durable Session HITL and resumes exact tool result", async () => {
    const fixture = await createFixture();
    const registry = createRegistry([askUserTool]);
    mockToolCallStream([{ toolCallId: "ask-1", toolName: "ask_user", input: {
      questions: [{ header: "Pick", question: "Choose a color", options: [], custom: true }],
    } }]);

    await runQueryLoop(fixture.options(registry, ["ask_user"]), "ask");

    const pending = await singlePendingHitl(fixture);
    expect(pending.source).toEqual({ type: "ask_user", sessionId: fixture.sessionId, toolCallId: "ask-1" });
    expect(fixture.store.getState().executions.at(-1)).toMatchObject({ status: "waiting_for_human" });
    expect(fixture.store.getState().blockedByHitlIds).toEqual([pending.hitlId]);
    expect(JSON.stringify(await Bun.file(getSessionHitlPath(fixture.workspaceRoot, fixture.sessionId)).json())).not.toContain("rawToolInput");
    const checkpointFile = await readSessionHitlCheckpointFile(fixture.workspaceRoot, fixture.sessionId);
    expect(JSON.stringify(checkpointFile)).toContain("Choose a color");

    await fixture.coordinator.respond(pending.hitlId, { type: "question_answer", answers: ["blue"] });
    await waitFor(async () => (await fixture.hitl.lookup(pending.hitlId)).status === "found" && ((await fixture.hitl.lookup(pending.hitlId)) as { record: HitlRecord }).record.status === "resolved");

    const tool = latestToolPart(fixture.store.getState().messages, "ask-1");
    expect(tool).toMatchObject({ state: "completed", output: "blue" });
  });

  test("permission response is durably claimed before restart resume executes the blocked tool once", async () => {
    const fixture = await createFixture();
    const execute = mock(async () => "mutated");
    const registry = createRegistry([guardedTool("mutate", execute)]);
    mockToolCallStream([{ toolCallId: "perm-1", toolName: "mutate", input: { message: "raw secret value" } }]);

    const loopOrigin = {
      kind: "loop" as const,
      loopId: crypto.randomUUID(),
      runId: "run-1",
      trigger: "manual" as const,
      mode: "act" as const,
      approvalPolicy: "interactive" as const,
    };

    await runQueryLoop({ ...fixture.options(registry, ["mutate"]), origin: loopOrigin }, "mutate");

    const pending = await singlePendingHitl(fixture);
    expect((await readSessionHitlCheckpointFile(fixture.workspaceRoot, fixture.sessionId)).checkpoints[0]?.origin).toEqual(loopOrigin);
    const restarted = await recreateResumeRuntime(fixture, registry);
    const claimed = await restarted.coordinator.respond(pending.hitlId, { type: "permission_decision", decision: "approve_once" });
    expect(claimed).toMatchObject({ status: "claimed", scheduled: true, record: { status: "resume_claimed" } });
    await waitFor(async () => execute.mock.calls.length === 1);
    await waitFor(async () => (await restarted.hitl.lookup(pending.hitlId)).status === "found" && ((await restarted.hitl.lookup(pending.hitlId)) as { record: HitlRecord }).record.status === "resolved");

    expect(execute).toHaveBeenCalledTimes(1);
    const resumedStore = await restarted.sessions.getOrLoad(fixture.sessionId, fixture.workspaceRoot);
    expect(latestToolPart(resumedStore.getState().messages, "perm-1")).toMatchObject({ state: "completed", output: "mutated" });
  });

  test("chained Session HITL pause from continuation preserves the new blocker", async () => {
    const fixture = await createFixture({
      getAgent: ({ store, hitl, workspaceRoot, sessionId }) => ({
        store,
        run: mock(async () => {
          const next = await hitl.create({
            owner: { projectSlug: "archcode", ownerType: "session", ownerId: sessionId },
            blockingKey: `session:${sessionId}:ask:ask-next`,
            source: { type: "ask_user", sessionId, toolCallId: "ask-next" },
            displayPayload: { title: "Next question", summary: "Continue?", redacted: true },
          });
          await writeSessionHitlCheckpoint({
            version: 1,
            hitlId: next.hitlId,
            blockingKey: next.blockingKey,
            source: next.source,
            toolCallId: "ask-next",
            toolName: "ask_user",
            step: 1,
            rawToolInput: { questions: [{ header: "Next", question: "Continue?", options: [], custom: true }] },
            displayInput: { questions: [{ header: "Next", question: "Continue?", options: [], custom: true }] },
            allowedTools: ["ask_user"],
            agentSkills: [],
            toolCalls: [{ toolCallId: "ask-next", toolName: "ask_user", input: { questions: [{ header: "Next", question: "Continue?", options: [], custom: true }] } }],
            completedToolResults: [],
            pendingToolCalls: [{ toolCallId: "ask-next", toolName: "ask_user", input: { questions: [{ header: "Next", question: "Continue?", options: [], custom: true }] } }],
            blockedToolIndex: 0,
            createdAt: new Date().toISOString(),
            kind: "ask_user",
          }, workspaceRoot, sessionId);
          store.getState().append({ type: "hitl.request", request: next });
          store.getState().append({
            type: "execution-end",
            status: "waiting_for_human",
            blockedByHitlIds: [next.hitlId],
            blockedToolCallId: "ask-next",
            blockedHitl: {
              version: 1,
              hitlId: next.hitlId,
              blockingKey: next.blockingKey,
              source: next.source,
              toolCallId: "ask-next",
              toolName: "ask_user",
              step: 1,
              displayInput: { questions: [{ header: "Next", question: "Continue?", options: [], custom: true }] },
              blockedAt: new Date().toISOString(),
              reason: "Next question",
            },
          });
          return { text: "", steps: 0 };
        }),
        dispose: mock(() => undefined),
      } as Agent),
    });
    const execute = mock(async () => "first mutation");
    const registry = createRegistry([guardedTool("mutate", execute)]);
    mockToolCallStream([{ toolCallId: "perm-chain", toolName: "mutate", input: { message: "raw old" } }]);

    await runQueryLoop(fixture.options(registry, ["mutate"]), "chain");
    const oldPending = await singlePendingHitl(fixture);
    await fixture.coordinator.respond(oldPending.hitlId, { type: "permission_decision", decision: "approve_once" });
    await waitFor(async () => (await fixture.hitl.lookup(oldPending.hitlId)).status === "found" && ((await fixture.hitl.lookup(oldPending.hitlId)) as { record: HitlRecord }).record.status === "resolved");

    const state = fixture.store.getState();
    const nextHitlId = state.blockedHitl?.hitlId;
    if (nextHitlId === undefined) throw new Error("Expected chained HITL blocker");
    expect(nextHitlId).not.toBe(oldPending.hitlId);
    expect(state.blockedByHitlIds).toEqual([nextHitlId]);
    expect(state.blockedHitl).toMatchObject({ hitlId: nextHitlId, toolCallId: "ask-next", toolName: "ask_user" });
    const checkpointFile = await readSessionHitlCheckpointFile(fixture.workspaceRoot, fixture.sessionId);
    expect(checkpointFile.checkpoints.map((checkpoint) => checkpoint.hitlId)).toEqual([nextHitlId]);
  });

  test("permission denial and cancel resume stable original toolCallId errors without executing tool", async () => {
    const denied = await createFixture();
    const deniedExecute = mock(async () => "should not run");
    const deniedRegistry = createRegistry([guardedTool("mutate", deniedExecute)]);
    mockToolCallStream([{ toolCallId: "perm-deny", toolName: "mutate", input: { message: "deny secret" } }]);
    await runQueryLoop(denied.options(deniedRegistry, ["mutate"]), "deny");

    const deniedPending = await singlePendingHitl(denied);
    await denied.coordinator.respond(deniedPending.hitlId, { type: "permission_decision", decision: "deny" });
    await waitFor(async () => (await denied.hitl.lookup(deniedPending.hitlId)).status === "found" && ((await denied.hitl.lookup(deniedPending.hitlId)) as { record: HitlRecord }).record.status === "resolved");

    const deniedTool = latestToolPart(denied.store.getState().messages, "perm-deny");
    expect(deniedExecute).not.toHaveBeenCalled();
    expect(deniedTool).toMatchObject({ state: "error", toolCallId: "perm-deny", toolName: "mutate" });
    expect(JSON.stringify(deniedTool)).toContain("TOOL_PERMISSION_CONFIRMATION_DENIED");

    const cancelled = await createFixture();
    const cancelExecute = mock(async () => "should not run");
    const cancelRegistry = createRegistry([guardedTool("mutate", cancelExecute)]);
    mockToolCallStream([{ toolCallId: "perm-cancel", toolName: "mutate", input: { message: "cancel secret" } }]);
    await runQueryLoop(cancelled.options(cancelRegistry, ["mutate"]), "cancel");

    const cancelPending = await singlePendingHitl(cancelled);
    await cancelled.coordinator.cancel(cancelPending.hitlId, "User cancelled");
    await waitFor(async () => (await cancelled.hitl.lookup(cancelPending.hitlId)).status === "found" && ((await cancelled.hitl.lookup(cancelPending.hitlId)) as { record: HitlRecord }).record.status === "cancelled");

    const cancelledTool = latestToolPart(cancelled.store.getState().messages, "perm-cancel");
    expect(cancelExecute).not.toHaveBeenCalled();
    expect(cancelledTool).toMatchObject({ state: "error", toolCallId: "perm-cancel", toolName: "mutate" });
    expect(JSON.stringify(cancelledTool)).toContain("TOOL_CANCELLED");
  });

  test("permission resume fails closed when checkpoint blocked tool is missing", async () => {
    const fixture = await createFixture();
    const execute = mock(async () => "should not run");
    const registry = createRegistry([
      guardedTool("blocked", execute),
      guardedTool("later", execute, { ask: false }),
    ]);
    mockToolCallStream([
      { toolCallId: "perm-missing", toolName: "blocked", input: { message: "raw should stay checkpoint-only" } },
      { toolCallId: "later-after-missing", toolName: "later", input: {} },
    ]);
    await runQueryLoop(fixture.options(registry, ["blocked", "later"]), "invalid checkpoint");

    const pending = await singlePendingHitl(fixture);
    const checkpoint = (await readSessionHitlCheckpointFile(fixture.workspaceRoot, fixture.sessionId)).checkpoints[0]!;
    await writeSessionHitlCheckpoint({ ...checkpoint, pendingToolCalls: checkpoint.pendingToolCalls.slice(1) }, fixture.workspaceRoot, fixture.sessionId);

    await fixture.coordinator.respond(pending.hitlId, { type: "permission_decision", decision: "approve_once" });
    await waitFor(async () => (await fixture.hitl.lookup(pending.hitlId)).status === "found" && ((await fixture.hitl.lookup(pending.hitlId)) as { record: HitlRecord }).record.status === "resolved");

    expect(execute).not.toHaveBeenCalled();
    const failedTool = latestToolPart(fixture.store.getState().messages, "perm-missing");
    expect(failedTool).toMatchObject({ state: "error", toolCallId: "perm-missing", toolName: "blocked" });
    expect(JSON.stringify(failedTool)).toContain("SESSION_HITL_CHECKPOINT_INVALID");
    expect(latestToolPart(fixture.store.getState().messages, "later-after-missing")).toMatchObject({
      state: "error",
      toolCallId: "later-after-missing",
      toolName: "later",
    });
  });

  test("multi-tool HITL checkpoint preserves ordered batch and does not start later effectful tool before response", async () => {
    const fixture = await createFixture();
    const events: string[] = [];
    const registry = createRegistry([
      defineTool({
        name: "first",
        description: "First safe tool",
        inputSchema: z.object({}).strict(),
        traits: { readOnly: true, destructive: false, concurrencySafe: true },
        execute: async () => {
          events.push("execute:first");
          return "first ok";
        },
      }),
      guardedTool("blocked", async () => {
        events.push("execute:blocked");
        return "blocked ok";
      }),
      guardedTool("later", async () => {
        events.push("execute:later");
        return "later ok";
      }, { ask: false }),
    ]);
    mockToolCallStream([
      { toolCallId: "tc-first", toolName: "first", input: {} },
      { toolCallId: "tc-blocked", toolName: "blocked", input: {} },
      { toolCallId: "tc-later", toolName: "later", input: {} },
    ]);

    await runQueryLoop(fixture.options(registry, ["first", "blocked", "later"]), "multi");

    expect(events).toEqual(["execute:first"]);
    const pending = await singlePendingHitl(fixture);
    const checkpoint = (await readSessionHitlCheckpointFile(fixture.workspaceRoot, fixture.sessionId)).checkpoints[0]!;
    expect(checkpoint.toolCalls.map((call) => call.toolCallId)).toEqual(["tc-first", "tc-blocked", "tc-later"]);
    expect(checkpoint.completedToolResults.map((result) => result.toolCallId)).toEqual(["tc-first"]);
    expect(checkpoint.pendingToolCalls.map((call) => call.toolCallId)).toEqual(["tc-blocked", "tc-later"]);

    await fixture.coordinator.respond(pending.hitlId, { type: "permission_decision", decision: "approve_once" });
    await waitFor(() => events.includes("execute:later"));

    expect(events).toEqual(["execute:first", "execute:blocked", "execute:later"]);
    expect(latestToolPart(fixture.store.getState().messages, "tc-later")).toMatchObject({ state: "completed", output: "later ok" });
  });
});

async function createFixture(options: {
  readonly getAgent?: (input: {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly store: ReturnType<SessionStoreManager["create"]>;
    readonly hitl: HitlService;
  }) => Agent;
} = {}) {
  const workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
  const sessionId = crypto.randomUUID();
  const sessions = new SessionStoreManager({ logger: silentLogger });
  const store = sessions.create(sessionId, workspaceRoot);
  const goalState = new GoalStateManager(workspaceRoot, silentLogger);
  const loopState = new LoopStateManager(workspaceRoot, silentLogger);
  const hitl = new HitlService({ workspaceRoot, project: { slug: "archcode", name: "ArchCode" }, sessions, goalState, loopState });
  await hitl.load(workspaceRoot);
  const approvals = new ProjectApprovalManager(silentLogger);
  await approvals.load(workspaceRoot);
  const projectContext: ProjectContext = {
    project: { slug: "archcode", name: "ArchCode", workspaceRoot, addedAt: new Date().toISOString() },
    goalState,
    goalArtifacts: new GoalArtifactManager(workspaceRoot),
    goalMemory: new GoalMemoryManager(workspaceRoot),
    loopState,
    hitl,
    memory: new MemoryFileManager({ project: join(workspaceRoot, ".archcode", "memory"), user: join(workspaceRoot, ".archcode", "user-memory") }),
    approvals,
  };
  const resolver = new ProjectContextResolver({ sessionStoreManager: sessions });
  resolver.alias(workspaceRoot, projectContext);
  const adapter = (registry: ReturnType<typeof createRegistry>) => new SessionHitlResumeAdapter({
    workspaceRoot,
    storeManager: sessions,
    toolRegistry: registry,
    projectContextResolver: resolver,
    ...(options.getAgent === undefined ? {} : { getAgent: async () => options.getAgent!({ workspaceRoot, sessionId, store, hitl }) }),
  });
  let currentRegistry = createRegistry();
  const coordinator = new ResumeCoordinator({ hitl, adapters: { session: { resume: (record, response) => adapter(currentRegistry).resume(record, response) } } });
  projectContext.hitlResumeCoordinator = coordinator;

  return {
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
        agentSkills: [],
        skillService: testSkillService,
        storeManager: sessions,
        workspaceRoot,
        projectContext,
        store,
      };
    },
  };
}

async function recreateResumeRuntime(fixture: Awaited<ReturnType<typeof createFixture>>, registry: ReturnType<typeof createRegistry>) {
  const sessions = new SessionStoreManager({ logger: silentLogger });
  const goalState = new GoalStateManager(fixture.workspaceRoot, silentLogger);
  const loopState = new LoopStateManager(fixture.workspaceRoot, silentLogger);
  const hitl = new HitlService({ workspaceRoot: fixture.workspaceRoot, project: { slug: "archcode", name: "ArchCode" }, sessions, goalState, loopState });
  await hitl.load(fixture.workspaceRoot);
  const approvals = new ProjectApprovalManager(silentLogger);
  await approvals.load(fixture.workspaceRoot);
  const projectContext: ProjectContext = {
    project: { slug: "archcode", name: "ArchCode", workspaceRoot: fixture.workspaceRoot, addedAt: new Date().toISOString() },
    goalState,
    goalArtifacts: new GoalArtifactManager(fixture.workspaceRoot),
    goalMemory: new GoalMemoryManager(fixture.workspaceRoot),
    loopState,
    hitl,
    memory: new MemoryFileManager({ project: join(fixture.workspaceRoot, ".archcode", "memory"), user: join(fixture.workspaceRoot, ".archcode", "user-memory") }),
    approvals,
  };
  const resolver = new ProjectContextResolver({ sessionStoreManager: sessions });
  resolver.alias(fixture.workspaceRoot, projectContext);
  const adapter = new SessionHitlResumeAdapter({
    workspaceRoot: fixture.workspaceRoot,
    storeManager: sessions,
    toolRegistry: registry,
    projectContextResolver: resolver,
    skillService: testSkillService,
  });
  const coordinator = new ResumeCoordinator({ hitl, adapters: { session: adapter } });
  projectContext.hitlResumeCoordinator = coordinator;
  return { sessions, hitl, coordinator };
}

function guardedTool(name: string, execute: (input: { message?: string }) => Promise<string>, options: { ask?: boolean } = {}) {
  return defineTool({
    name,
    description: `Guarded ${name}`,
    inputSchema: z.object({ message: z.string().optional() }).strict(),
    traits: { readOnly: false, destructive: true, concurrencySafe: false },
    permissions: [async () => options.ask === false ? { outcome: "allow" } : { outcome: "ask", reason: `Approve ${name}` }],
    execute,
  });
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
  const file = await Bun.file(getSessionHitlPath(fixture.workspaceRoot, fixture.sessionId)).json() as { pending: HitlRecord[] };
  expect(file.pending).toHaveLength(1);
  return file.pending[0]!;
}

function latestToolPart(messages: Awaited<ReturnType<typeof createFixture>>["store"]["getState"] extends () => infer State ? State extends { messages: infer Messages } ? Messages : never : never, toolCallId: string) {
  for (const message of [...messages].reverse()) {
    for (const part of [...message.parts].reverse()) {
      if (part.type === "tool" && part.toolCallId === toolCallId) return part;
    }
  }
  throw new Error(`Missing tool part ${toolCallId}`);
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition was not met");
}
