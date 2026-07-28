import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  MAX_EVENTS,
  type FinalizedToolResult,
  type SessionEventEnvelope,
  type SessionPart,
  type ToolOutputDeltaEvent,
  type ToolResultEvent,
} from "@archcode/protocol";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HitlBoundaryCodec } from "../hitl/boundary-codec";
import { silentLogger } from "../logger";
import { SecretRedactionPolicy } from "../security";
import {
  SessionToolBatchScheduler,
  type SessionToolBatchQueue,
} from "../execution/session-tool-batch-scheduler";
import { SessionStoreManager } from "../store/session-store-manager";
import type { SessionStoreState } from "../store/types";
import { testExecutionStart } from "../testing/test-execution-fixtures";
import { bashTool, runBashCommand } from "../tools/builtins/bash";
import { createTestProjectContext } from "../tools/test-project-context";
import { createRegistry } from "../tools/registry";
import {
  createToolExecutionContext,
  type AnyToolDescriptor,
  type ToolExecutionContext,
} from "../tools/types";
import { createScopeBoundToolOutputAccess } from "./access-service";
import { ToolOutputArtifactStore } from "./artifact-store";
import { ToolOutputFinalizer } from "./finalizer";
import { LiveToolOutputPublisher } from "./live-publisher";

interface LiveBashHarness {
  readonly root: string;
  readonly workspace: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly stepId: string;
  readonly storeManager: SessionStoreManager;
  readonly store: ReturnType<SessionStoreManager["create"]>;
  readonly scheduler: SessionToolBatchScheduler;
  readonly abortController: AbortController;
  readonly artifactStore: ToolOutputArtifactStore;
  readonly finalizedObservations: Map<string, {
    readonly publisherStopped: boolean;
    readonly deltaCount: number;
  }>;
}

interface StartedBashCall {
  readonly toolCallId: string;
  readonly completion: Promise<void>;
  readonly finished: () => boolean;
}

let harness: LiveBashHarness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.artifactStore.dispose();
  await rm(harness.root, { recursive: true, force: true });
});

describe("live Bash output through the durable Session tool path", () => {
  test("publishes a real delayed delta before completion, then checkpoints the authoritative final", async () => {
    const startedAt = Date.now();
    const call = await startBash({
      description: "Emit two delayed sentinels",
      command: "printf 'FIRST_SENTINEL\\n'; sleep 0.6; printf 'LAST_SENTINEL\\n'",
    });

    const firstLive = await waitForDelta(call.toolCallId, (event) => event.payload.delta.includes("FIRST_SENTINEL"));
    expect(call.finished()).toBe(false);

    const transientOnly = "TRANSIENT_MODEL_FORBIDDEN";
    harness.store.getState().append({
      type: "tool-output-delta",
      toolCallId: call.toolCallId,
      toolName: "bash",
      delta: transientOnly,
      omittedBytes: 0,
      liveLimitReached: false,
    });
    expect(JSON.stringify(harness.store.getState().toModelMessages())).not.toContain(transientOnly);

    await call.completion;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);

    const deltas = deltaEvents(call.toolCallId);
    const terminal = resultEvent(call.toolCallId);
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(firstLive.id).toBeLessThan(terminal.id);
    expect(deltas.every((event) => event.id < terminal.id)).toBe(true);
    expectStrictlyIncrementingSessionIds(harness.store.getState());

    const liveText = deltas.map((event) => event.payload.delta).join("");
    expect(liveText).toContain("FIRST_SENTINEL");
    expect(liveText).toContain("LAST_SENTINEL");
    expect(terminal.payload.result.isError).toBe(false);
    expect(terminal.payload.result.output.preview).toContain("FIRST_SENTINEL");
    expect(terminal.payload.result.output.preview).toContain("LAST_SENTINEL");
    expect(terminal.payload.result.output.preview).not.toContain(transientOnly);

    await expectDurableFinalMatchesTerminal(call.toolCallId, terminal);
    expectSettledProjectionMatchesFinal(call.toolCallId, terminal.payload.result, terminal.payload.settledAt);
    const settledModelProjection = JSON.stringify(harness.store.getState().toModelMessages());
    expect(settledModelProjection).not.toContain(transientOnly);
    expect(settledModelProjection).toContain("FIRST_SENTINEL");
    expect(settledModelProjection).toContain("LAST_SENTINEL");
  });

  test("survives disconnect, ring eviction, and restart with only the authoritative final persisted", async () => {
    const trace = {
      version: "2" as const,
      status: "compiled" as const,
      hash: "a".repeat(64),
      sections: [{
        name: "Runtime Envelope",
        source: "runtime/snapshot",
        hash: "b".repeat(64),
      }],
      skills: { status: "absent" as const, active: [] },
      visibleTools: ["bash"],
      agentsMd: "present" as const,
      memory: "absent" as const,
      mcp: {},
      warnings: [],
    };
    harness.store.getState().append({ type: "prompt-trace", trace });
    await harness.storeManager.flushSession(harness.sessionId, harness.workspace);

    let onlineDeltaCount = 0;
    const unsubscribe = harness.storeManager.subscribeToSessionEvents(({ envelope }) => {
      if (envelope.payload.type === "tool-output-delta") onlineDeltaCount += 1;
    });
    const call = await startBash({
      description: "Emit a recoverable artifact across delayed live windows",
      command: [
        "printf 'HEAD_RESTART_SENTINEL\\n'",
        "sleep 0.25",
        "i=0",
        "while [ \"$i\" -lt 5000 ]; do",
        "  printf 'BODY_%05d_payload_payload\\n' \"$i\"",
        "  i=$((i + 1))",
        "done",
        "sleep 0.25",
        "printf 'TAIL_RESTART_SENTINEL\\n'",
      ].join("\n"),
    });
    await waitForDelta(call.toolCallId, (event) =>
      event.payload.delta.includes("HEAD_RESTART_SENTINEL")
    );
    expect(onlineDeltaCount).toBeGreaterThanOrEqual(1);
    unsubscribe();

    await call.completion;
    const transientDeltas = deltaEvents(call.toolCallId);
    expect(transientDeltas.length).toBeGreaterThanOrEqual(3);
    const terminal = resultEvent(call.toolCallId);
    expect(terminal.payload.result.output.recovery.kind).toBe("artifact");
    if (terminal.payload.result.output.recovery.kind !== "artifact") {
      throw new Error("Expected recoverable Bash artifact");
    }
    const outputRef = terminal.payload.result.output.recovery.outputRef;
    await expectDurableFinalMatchesTerminal(call.toolCallId, terminal);

    const firstEvictionId = harness.store.getState().nextEventId;
    for (let index = 0; index < MAX_EVENTS; index += 1) {
      harness.store.getState().append({
        type: "reminder-consumed",
        reminderIds: [`evict-${index}`],
      });
    }
    const evicted = harness.store.getState();
    expect(evicted.events).toHaveLength(MAX_EVENTS);
    expect(evicted.events[0]?.id).toBe(firstEvictionId);
    expect(evicted.events.some((event) =>
      event.payload.type === "prompt-trace"
      || event.payload.type === "tool-output-delta"
      || event.payload.type === "tool-result"
    )).toBe(false);

    await harness.storeManager.commitDurableSessionMutation(
      harness.sessionId,
      harness.workspace,
      () => ({
        result: undefined,
        patch: { title: "persist post-eviction cursor" },
      }),
    );
    const persisted = await harness.storeManager.getSessionFile(
      harness.workspace,
      harness.sessionId,
    );
    expect(persisted.promptTraces).toEqual([trace]);
    const persistedCall = persisted.toolBatches.flatMap((batch) => batch.calls)
      .find((candidate) => candidate.toolCallId === call.toolCallId);
    expect(persistedCall?.result).toEqual(terminal.payload.result);
    expect(JSON.stringify(persistedCall?.result)).toContain(outputRef);
    expect(persisted.eventCursor).toBe(evicted.nextEventId - 1);

    const restartedManager = new SessionStoreManager({ logger: silentLogger });
    const restarted = await restartedManager.getOrLoad(
      harness.sessionId,
      harness.workspace,
    );
    expect(restarted.getState().promptTraces).toEqual([trace]);
    expect(restarted.getState().events).toEqual([]);
    expect(restarted.getState().nextEventId).toBe(persisted.eventCursor + 1);
    const restartedPart = sessionParts(restarted.getState())
      .find((part) => part.type === "tool" && part.toolCallId === call.toolCallId);
    expect(restartedPart).toMatchObject({
      type: "tool",
      state: "completed",
      result: terminal.payload.result,
    });
    expect(restartedPart).not.toHaveProperty("liveOutput");

    const continuedAt = restarted.getState().nextEventId;
    restarted.getState().append({ type: "system-notice", message: "after restart" });
    expect(restarted.getState().events).toHaveLength(1);
    expect(restarted.getState().events[0]?.id).toBe(continuedAt);

    const reopenedArtifacts = new ToolOutputArtifactStore({
      rootDir: join(harness.root, "tool-outputs"),
    });
    try {
      await reopenedArtifacts.ready();
      const access = createScopeBoundToolOutputAccess(reopenedArtifacts, {
        workspaceRoot: harness.workspace,
        rootSessionId: harness.sessionId,
      });
      expect(await access.countRecoverable()).toBe(1);
      let cursor: string | undefined;
      let recovered = "";
      do {
        const page = await access.read({
          outputRef,
          limit: 1_000,
          maxContentBytes: 50 * 1024,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(page.completeness).toBe("complete");
        expect(page.gap).toBeUndefined();
        recovered += page.records.map((record) => record.text).join("");
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      expect(recovered).toContain("HEAD_RESTART_SENTINEL");
      expect(recovered).toContain("TAIL_RESTART_SENTINEL");
    } finally {
      await reopenedArtifacts.dispose();
    }
  });

  test("keeps live ordering and the durable final for a nonzero Bash exit", async () => {
    const call = await startBash({
      description: "Emit delayed output and fail",
      command: "printf 'FIRST_SENTINEL\\n'; sleep 0.5; printf 'LAST_SENTINEL\\n' >&2; exit 7",
    });

    await waitForDelta(call.toolCallId, (event) => event.payload.delta.includes("FIRST_SENTINEL"));
    expect(call.finished()).toBe(false);
    await call.completion;

    const terminal = resultEvent(call.toolCallId);
    expect(deltaEvents(call.toolCallId).every((event) => event.id < terminal.id)).toBe(true);
    expect(terminal.payload.result).toMatchObject({
      isError: true,
      details: {
        error: { code: "TOOL_BASH_NONZERO_EXIT" },
        process: { exitCode: 7, timedOut: false, aborted: false },
      },
    });
    expect(terminal.payload.result.output.preview).toContain("FIRST_SENTINEL");
    expect(terminal.payload.result.output.preview).toContain("LAST_SENTINEL");
    await expectDurableFinalMatchesTerminal(call.toolCallId, terminal);
    expectSettledProjectionMatchesFinal(call.toolCallId, terminal.payload.result, terminal.payload.settledAt);
  });

  test("flushes partial live output before a real Bash timeout final", async () => {
    const call = await startBash({
      description: "Emit output before timing out",
      command: "printf 'FIRST_SENTINEL\\n'; exec sleep 5",
      timeoutMs: 300,
    });

    await waitForDelta(call.toolCallId, (event) => event.payload.delta.includes("FIRST_SENTINEL"));
    expect(call.finished()).toBe(false);
    await call.completion;

    const terminal = resultEvent(call.toolCallId);
    expect(deltaEvents(call.toolCallId).every((event) => event.id < terminal.id)).toBe(true);
    expect(terminal.payload.result).toMatchObject({
      isError: true,
      details: {
        error: { code: "TOOL_BASH_TIMEOUT" },
        process: { timedOut: true, aborted: false },
      },
    });
    expect(terminal.payload.result.output.preview).toContain("FIRST_SENTINEL");
    await expectDurableFinalMatchesTerminal(call.toolCallId, terminal);
    expectSettledProjectionMatchesFinal(call.toolCallId, terminal.payload.result, terminal.payload.settledAt);
  });

  test("flushes partial live output before a real Bash abort final", async () => {
    const call = await startBash({
      description: "Emit output before aborting",
      command: "printf 'FIRST_SENTINEL\\n'; exec sleep 5",
    });

    await waitForDelta(call.toolCallId, (event) => event.payload.delta.includes("FIRST_SENTINEL"));
    expect(call.finished()).toBe(false);
    harness.abortController.abort("integration test abort");
    await call.completion;

    const terminal = resultEvent(call.toolCallId);
    expect(deltaEvents(call.toolCallId).every((event) => event.id < terminal.id)).toBe(true);
    expect(terminal.payload.result).toMatchObject({
      isError: true,
      details: {
        error: { code: "TOOL_BASH_ABORTED" },
        process: { timedOut: false, aborted: true },
      },
    });
    expect(terminal.payload.result.output.preview).toContain("FIRST_SENTINEL");
    await expectDurableFinalMatchesTerminal(call.toolCallId, terminal);
    expectSettledProjectionMatchesFinal(call.toolCallId, terminal.payload.result, terminal.payload.settledAt);
  });

  test("flushes partial live output and disposes the publisher before a real signal final", async () => {
    const call = await startBash({
      description: "Emit output before terminating on a signal",
      command: "printf 'SIGNAL_SENTINEL\\n'; kill -TERM $$",
    });

    await call.completion;

    const terminal = resultEvent(call.toolCallId);
    const deltas = deltaEvents(call.toolCallId);
    expect(deltas.map((event) => event.payload.delta).join("")).toContain("SIGNAL_SENTINEL");
    expect(deltas.every((event) => event.id < terminal.id)).toBe(true);
    expect(terminal.payload.result).toMatchObject({
      isError: true,
      details: {
        error: { code: "TOOL_BASH_ABORTED" },
        process: { signal: "SIGTERM", timedOut: false, aborted: true },
      },
    });
    expectTerminalPublisherDisposed(call.toolCallId);
    await expectDurableFinalMatchesTerminal(call.toolCallId, terminal);
  });

  test("spawn failure settles clearly without publishing a synthetic delta", async () => {
    await replaceHarness({
      descriptorFactory: () => ({
        ...bashTool,
        execute: (input, context) => runBashCommand(input, context, {
          async run(processInput) {
            return {
              kind: "spawn-failure",
              argv: processInput.argv,
              ...(processInput.cwd === undefined ? {} : { cwd: processInput.cwd }),
              error: { name: "SpawnError", message: "unable to spawn bash" },
            };
          },
        }),
      }),
    });

    const call = await startBash({
      description: "Exercise spawn failure",
      command: "printf 'must not run'",
    });
    await call.completion;

    const terminal = resultEvent(call.toolCallId);
    expect(deltaEvents(call.toolCallId)).toHaveLength(0);
    expect(terminal.payload.result.isError).toBe(true);
    expect(terminal.payload.result.output.preview).toContain("unable to spawn bash");
    expectTerminalPublisherDisposed(call.toolCallId, 0);
    await expectDurableFinalMatchesTerminal(call.toolCallId, terminal);
  });

  test("execute failure before output settles clearly without publishing a synthetic delta", async () => {
    await replaceHarness({
      descriptorFactory: () => ({
        ...bashTool,
        execute: async () => {
          throw new Error("execute failed before output");
        },
      }),
    });

    const call = await startBash({
      description: "Exercise pre-output execute failure",
      command: "printf 'must not run'",
    });
    await call.completion;

    const terminal = resultEvent(call.toolCallId);
    expect(deltaEvents(call.toolCallId)).toHaveLength(0);
    expect(terminal.payload.result).toMatchObject({
      isError: true,
      details: { unknownResult: true },
    });
    expect(terminal.payload.result.output.preview).toContain("execute failed before output");
    expectTerminalPublisherDisposed(call.toolCallId, 0);
    await expectDurableFinalMatchesTerminal(call.toolCallId, terminal);
  });

  test("finalizer synthesis settles clearly without publishing a synthetic delta", async () => {
    await replaceHarness({
      descriptorFactory: () => ({
        ...bashTool,
        execute: async () => ({ isError: false, draft: { kind: "capture" as const } }),
      }),
      configureFinalizer(finalizer) {
        spyOn(finalizer, "finalize").mockRejectedValueOnce(new Error("catastrophic finalizer failure"));
      },
    });

    const call = await startBash({
      description: "Exercise finalizer synthesis",
      command: "true",
    });
    await call.completion;

    const terminal = resultEvent(call.toolCallId);
    expect(deltaEvents(call.toolCallId)).toHaveLength(0);
    expect(terminal.payload.result).toMatchObject({
      isError: true,
      details: {
        error: { code: "TOOL_OUTPUT_UNAVAILABLE" },
        unknownResult: true,
      },
    });
    expectTerminalPublisherDisposed(call.toolCallId, 0);
    await expectDurableFinalMatchesTerminal(call.toolCallId, terminal);
  });

  test("capture failure flushes transient output before a clear final and excludes it from settled/model state", async () => {
    const transient = "CAPTURE_FAILURE_TRANSIENT";
    await replaceHarness({
      descriptorFactory: (artifactRoot) => ({
        ...bashTool,
        execute: async (_input, context) => {
          const capture = context.outputCapture;
          if (capture === undefined) throw new Error("missing Registry capture");
          await capture.write(transient, { source: "bash-live" });
          while (capture.stats().queuedBytes > 0) await Bun.sleep(1);
          for (const entry of await readdir(artifactRoot, { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name.startsWith(".tmp-")) {
              await rm(join(artifactRoot, entry.name), { recursive: true, force: true });
            }
          }
          return { isError: false, draft: { kind: "capture" as const } };
        },
      }),
    });

    const call = await startBash({
      description: "Exercise capture finalization failure",
      command: "printf 'must not run'",
    });
    await call.completion;

    const terminal = resultEvent(call.toolCallId);
    const deltas = deltaEvents(call.toolCallId);
    expect(deltas.map((event) => event.payload.delta).join("")).toContain(transient);
    expect(deltas.every((event) => event.id < terminal.id)).toBe(true);
    expect(terminal.payload.result).toMatchObject({
      isError: true,
      details: {
        error: { code: "TOOL_OUTPUT_UNAVAILABLE" },
        unknownResult: true,
      },
    });
    expect(terminal.payload.result.output.preview).not.toContain(transient);
    expect(JSON.stringify(harness.store.getState().toModelMessages())).not.toContain(transient);
    expectSettledProjectionMatchesFinal(call.toolCallId, terminal.payload.result, terminal.payload.settledAt);
    expectTerminalPublisherDisposed(call.toolCallId);
    await expectDurableFinalMatchesTerminal(call.toolCallId, terminal);
  });
});

async function createHarness(options: {
  readonly descriptorFactory?: (artifactRoot: string) => AnyToolDescriptor;
  readonly configureFinalizer?: (finalizer: ToolOutputFinalizer) => void;
} = {}): Promise<LiveBashHarness> {
  const root = await mkdtemp(join(tmpdir(), "archcode-live-bash-"));
  const workspace = join(root, "workspace");
  const artifactRoot = join(root, "tool-outputs");
  await mkdir(workspace, { recursive: true });

  const storeManager = new SessionStoreManager({ logger: silentLogger });
  const sessionId = crypto.randomUUID();
  const store = storeManager.create(sessionId, workspace, {
    agentName: "lead",
    cwd: workspace,
  });
  const executionId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  store.getState().append(testExecutionStart(executionId));
  store.getState().append({ type: "step-start", stepId, step: 0 });
  await storeManager.flushSession(sessionId, workspace);

  const projectContext = createTestProjectContext(workspace, storeManager);
  const artifactStore = new ToolOutputArtifactStore({ rootDir: artifactRoot });
  await artifactStore.ready();
  const finalizer = new ToolOutputFinalizer({ artifactStore });
  options.configureFinalizer?.(finalizer);
  const registry = createRegistry({
    finalizer,
    hitlCodec: new HitlBoundaryCodec(new SecretRedactionPolicy([])),
    logger: silentLogger,
  }, [options.descriptorFactory?.(artifactRoot) ?? bashTool]);
  const finalizedObservations = new Map<string, {
    readonly publisherStopped: boolean;
    readonly deltaCount: number;
  }>();
  registry.globalHooks.finalized.push((_result, context) => {
    finalizedObservations.set(context.toolCallId, {
      publisherStopped: context.liveToolOutput?.stopped === true,
      deltaCount: context.store.getState().events.filter((event) =>
        event.payload.type === "tool-output-delta"
        && event.payload.toolCallId === context.toolCallId
      ).length,
    });
  });
  const abortController = new AbortController();
  let scheduler!: SessionToolBatchScheduler;

  const createContext = (call: { toolCallId: string; toolName: string; input: unknown }, step: number): ToolExecutionContext => {
    const batch = scheduler.activeBatch();
    if (batch === undefined) throw new Error("Expected an active Tool Batch");
    return createToolExecutionContext({
      store,
      storeManager,
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      input: call.input,
      step,
      executionId,
      runOrdinal: 0,
      toolBatchId: batch.batchId,
      abort: abortController.signal,
      agentName: "lead",
      startedAt: Date.now(),
      allowedTools: new Set(["bash"]),
      projectContext,
      cwd: workspace,
      liveToolOutput: new LiveToolOutputPublisher({
        store,
        toolCallId: call.toolCallId,
      }),
    });
  };
  const hitlQueue: SessionToolBatchQueue = projectContext.hitl;
  scheduler = new SessionToolBatchScheduler({
    executionId,
    runOrdinal: 0,
    store,
    storeManager,
    workspaceRoot: workspace,
    registry,
    hitlQueue,
    agentName: "lead",
    allowedTools: ["bash"],
    agentSkills: [],
    createContext,
  });

  return {
    root,
    workspace,
    sessionId,
    executionId,
    stepId,
    storeManager,
    store,
    scheduler,
    abortController,
    artifactStore,
    finalizedObservations,
  };
}

async function replaceHarness(options: Parameters<typeof createHarness>[0]): Promise<void> {
  await harness.artifactStore.dispose();
  await rm(harness.root, { recursive: true, force: true });
  harness = await createHarness(options);
}

async function startBash(input: {
  readonly description: string;
  readonly command: string;
  readonly timeoutMs?: number;
}): Promise<StartedBashCall> {
  const toolCallId = crypto.randomUUID();
  harness.store.getState().append({
    type: "tool-call",
    toolCallId,
    toolName: "bash",
    input,
  });
  await harness.scheduler.createBatch(
    [{ toolCallId, toolName: "bash", input }],
    harness.stepId,
    0,
  );

  let didFinish = false;
  const completion = harness.scheduler.advance().then((result) => {
    expect(result).toMatchObject({ status: "ready_for_continuation" });
  }).finally(() => {
    didFinish = true;
  });
  return { toolCallId, completion, finished: () => didFinish };
}

function deltaEvents(
  toolCallId: string,
): Array<SessionEventEnvelope<ToolOutputDeltaEvent>> {
  return harness.store.getState().events.flatMap((event) =>
    event.payload.type === "tool-output-delta" && event.payload.toolCallId === toolCallId
      ? [event as SessionEventEnvelope<ToolOutputDeltaEvent>]
      : []
  );
}

function resultEvent(
  toolCallId: string,
): SessionEventEnvelope<ToolResultEvent> {
  const event = harness.store.getState().events.find((candidate) =>
    candidate.payload.type === "tool-result" && candidate.payload.toolCallId === toolCallId
  );
  if (event === undefined || event.payload.type !== "tool-result") {
    throw new Error(`Missing terminal tool-result for ${toolCallId}`);
  }
  return event as SessionEventEnvelope<ToolResultEvent>;
}

async function waitForDelta(
  toolCallId: string,
  predicate: (event: SessionEventEnvelope<ToolOutputDeltaEvent>) => boolean,
): Promise<SessionEventEnvelope<ToolOutputDeltaEvent>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const event = deltaEvents(toolCallId).find(predicate);
    if (event !== undefined) return event;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for live delta from ${toolCallId}`);
}

function expectStrictlyIncrementingSessionIds(state: SessionStoreState): void {
  for (let index = 1; index < state.events.length; index += 1) {
    expect(state.events[index]!.id).toBe(state.events[index - 1]!.id + 1);
  }
}

function expectTerminalPublisherDisposed(toolCallId: string, deltaCount?: number): void {
  const observation = harness.finalizedObservations.get(toolCallId);
  expect(observation).toBeDefined();
  expect(observation?.publisherStopped).toBe(true);
  if (deltaCount !== undefined) expect(observation?.deltaCount).toBe(deltaCount);
}

async function expectDurableFinalMatchesTerminal(
  toolCallId: string,
  terminal: SessionEventEnvelope<ToolResultEvent>,
): Promise<void> {
  const persisted = await harness.storeManager.getSessionFile(harness.workspace, harness.sessionId);
  const call = persisted.toolBatches.flatMap((batch) => batch.calls)
    .find((candidate) => candidate.toolCallId === toolCallId);
  expect(call).toBeDefined();
  expect(call?.result).toEqual(terminal.payload.result);
  expect(call?.settledAt).toBe(terminal.payload.settledAt);
}

function expectSettledProjectionMatchesFinal(
  toolCallId: string,
  result: FinalizedToolResult,
  settledAt: number,
): void {
  const part = sessionParts(harness.store.getState())
    .find((candidate) => candidate.type === "tool" && candidate.toolCallId === toolCallId);
  expect(part).toBeDefined();
  expect(part).toMatchObject({
    type: "tool",
    state: result.isError ? "error" : "completed",
    toolCallId,
    result,
    endedAt: settledAt,
  });
  expect(part).not.toHaveProperty("liveOutput");
}

function sessionParts(state: SessionStoreState): SessionPart[] {
  const parts: SessionPart[] = [];
  for (const message of state.messages) {
    for (const part of message.parts) parts.push(part);
  }
  return parts;
}
