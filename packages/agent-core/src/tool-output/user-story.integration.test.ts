import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DelegationRequest, FinalizedToolResult } from "@archcode/protocol";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHybridCompressionHook } from "../agents/query/hooks/hybrid-compression";
import type { ExecutionModelBinding } from "../models";
import { HitlBoundaryCodec } from "../hitl/boundary-codec";
import { setLlmAdapterForTest } from "../llm";
import { silentLogger } from "../logger";
import { createProcessRunner } from "../process/runner";
import { SecretRedactionPolicy } from "../security";
import { SessionStoreManager } from "../store/session-store-manager";
import { toModelMessagesFromStoredMessages } from "../store/projection";
import { bashTool } from "../tools/builtins/bash";
import { outputReadTool, outputSearchTool } from "../tools/builtins/output-artifacts";
import { createTestProjectContext } from "../tools/test-project-context";
import { expectSettledResult } from "../tools/test-results";
import { createRegistry, type ToolRegistry } from "../tools/registry";
import type { ToolExecutionContext } from "../tools/types";
import { createScopeBoundToolOutputAccess, type ToolOutputAccessService } from "./access-service";
import { ToolOutputArtifactStore } from "./artifact-store";
import { ToolOutputFinalizer } from "./finalizer";
import { createHermeticArtifactSearchRunner } from "./fixtures/hermetic-search-runner";
import { isOutputRef } from "./ref";
import { createTestModelInfo, testExecutionStart } from "../testing/test-execution-fixtures";

const TOOL_NAMES = new Set(["bash", "output_read", "output_search"]);
const CHILD_REOPEN_FIXTURE = join(import.meta.dir, "fixtures", "reopen-store-child.ts");

interface OutputPlane {
  readonly store: ToolOutputArtifactStore;
  readonly registry: ToolRegistry;
}

interface StoryHarness {
  readonly root: string;
  readonly workspace: string;
  readonly artifactRoot: string;
  readonly sessions: SessionStoreManager;
  readonly rootSessionId: string;
  readonly childSessionId: string;
  readonly rootStore: ReturnType<SessionStoreManager["create"]>;
  readonly childStore: ReturnType<SessionStoreManager["create"]>;
}

let harness: StoryHarness;
const activeStores = new Set<ToolOutputArtifactStore>();

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "archcode-tool-output-story-"));
  const workspace = join(root, "workspace");
  const artifactRoot = join(root, "tool-outputs");
  await mkdir(workspace, { recursive: true });

  const sessions = new SessionStoreManager({ logger: silentLogger });
  const rootSessionId = crypto.randomUUID();
  const childSessionId = crypto.randomUUID();
  const delegationRequest: DelegationRequest = {
    agent_type: "build",
    profile: "deep",
    title: "Exercise the output artifact plane",
    objective: "Produce and recover a large tool output artifact",
    skills: [],
    background: false,
  };
  const rootStore = sessions.create(rootSessionId, workspace, {
    agentName: "lead",
    cwd: workspace,
  });
  const childStore = sessions.create(childSessionId, workspace, {
    agentName: "build",
    cwd: workspace,
    rootSessionId,
    parentSessionId: rootSessionId,
    delegationRequest,
  });
  await Promise.all([
    sessions.flushSession(rootSessionId, workspace),
    sessions.flushSession(childSessionId, workspace),
  ]);

  harness = {
    root,
    workspace,
    artifactRoot,
    sessions,
    rootSessionId,
    childSessionId,
    rootStore,
    childStore,
  };
});

afterEach(async () => {
  setLlmAdapterForTest(undefined);
  await Promise.all([...activeStores].map((store) => store.dispose()));
  activeStores.clear();
  await rm(harness.root, { recursive: true, force: true });
});

describe("Tool Output Plane real user stories", () => {
  test("rediscovers a compacted large Bash artifact through family search without reinjecting its ref", async () => {
    const plane = createOutputPlane(harness.artifactRoot);
    const access = scopeAccess(plane.store, harness.workspace, harness.rootSessionId);
    const command = [
      "printf 'COMPACT_HEAD\\n'",
      "i=0",
      "while [ \"$i\" -lt 12000 ]; do",
      "  printf 'COMPACT_BODY_%05d_payload_payload\\n' \"$i\"",
      "  if [ \"$i\" -eq 6000 ]; then printf 'COMPACT_FAMILY_SENTINEL\\n'; fi",
      "  i=$((i + 1))",
      "done",
      "printf 'COMPACT_TAIL\\n'",
    ].join("\n");
    const input = { description: "Emit output that must survive hard compact", command };
    const toolCallId = crypto.randomUUID();
    beginUserRound(harness.rootStore, "Run the diagnostic command");
    const context = executionContext(harness.rootStore, access, "bash", toolCallId);

    harness.rootStore.getState().append({ type: "tool-call", toolCallId, toolName: "bash", input });
    const result = await executeRegistered(plane.registry, "bash", input, context);
    harness.rootStore.getState().append({ type: "tool-result", toolCallId, toolName: "bash", result });
    harness.rootStore.getState().append({ type: "execution-end", status: "completed" });

    expect(result.output.recovery.kind).toBe("artifact");
    if (result.output.recovery.kind !== "artifact") throw new Error("Expected compact recovery artifact");
    const outputRef = result.output.recovery.outputRef;
    expect(result.output.preview).not.toContain("COMPACT_FAMILY_SENTINEL");
    expect(await access.countRecoverable()).toBe(1);

    appendCompletedRound(harness.rootStore, "Inspect the first observation", "The first observation is recorded");
    appendCompletedRound(harness.rootStore, "Inspect the second observation", "The second observation is recorded");
    appendCompletedRound(harness.rootStore, "Prepare the next action", "The next action is ready");

    let summarizerMessages: unknown;
    setLlmAdapterForTest({
      streamText: ((request: { readonly messages: unknown }) => {
        summarizerMessages = request.messages;
        return {
          text: Promise.resolve("## Current Objective\nContinue the diagnostic workflow without embedding prior tool output."),
        };
      }) as never,
    });

    const hook = createHybridCompressionHook(silentLogger, access);
    harness.rootStore.setState({
      steps: [{
        index: 0,
        finishReason: "stop",
        usage: { inputTokens: 850, outputTokens: 1, totalTokens: 851 },
      }] as never,
    });
    const modelInfo = createTestModelInfo({
      model: { modelId: "compact-user-story" } as never,
      displayName: "Compact user story",
      limit: { context: 1_000, output: 1_000 },
      providerId: "test",
      modelId: "compact-user-story",
    });
    const binding: ExecutionModelBinding = {
      modelInfo,
      options: undefined,
      summary: {
        selection: { model: modelInfo.qualifiedId },
        providerId: modelInfo.providerId,
        modelId: modelInfo.modelId,
        providerDisplayName: modelInfo.providerDisplayName,
        modelDisplayName: modelInfo.displayName,
        resolution: "profile_default",
        modelRuntimeRevision: "test-revision",
      },
    };

    await hook.beforeModelBuild({ store: harness.rootStore, binding, logger: silentLogger });
    const call = {
      store: harness.rootStore,
      binding,
      logger: silentLogger,
      messages: harness.rootStore.getState().toModelMessages(),
    };
    await hook.beforeModelCall(call);
    expect(await access.countRecoverable()).toBe(1);

    const summarizerJson = JSON.stringify(summarizerMessages);
    expect(summarizerJson).not.toContain(outputRef);
    expect(summarizerJson).not.toContain("COMPACT_FAMILY_SENTINEL");
    expect(summarizerJson).not.toContain("COMPACT_BODY_");

    const postCompactJson = JSON.stringify(call.messages);
    expect(harness.rootStore.getState().events.filter((event) => event.payload.type === "compact")).toHaveLength(1);
    expect(postCompactJson).not.toContain(outputRef);
    expect(postCompactJson).not.toContain("COMPACT_FAMILY_SENTINEL");
    expect(postCompactJson).not.toContain("COMPACT_BODY_");
    expect(postCompactJson).toContain("1 recoverable tool-output artifact");
    expect(postCompactJson).toContain("output_search without outputRef");
    const recoveryNotice = call.messages.find((message) => JSON.stringify(message).includes("Hard compact completed"));
    expect(recoveryNotice).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(recoveryNotice))).toBeLessThan(1_024);

    const searchResult = await executeRegistered(
      plane.registry,
      "output_search",
      { pattern: "COMPACT_FAMILY_SENTINEL" },
      executionContext(harness.rootStore, access, "output_search", crypto.randomUUID()),
    );
    expect(searchResult.isError).toBe(false);
    expect(searchResult.output.preview).toContain("COMPACT_FAMILY_SENTINEL");
    expect(searchResult.output.preview).toContain(outputRef);
  }, 20_000);

  test("recovers a large Registry-owned Bash artifact across Session, store, and Bun process boundaries", async () => {
    const plane = createOutputPlane(harness.artifactRoot);
    const childAccess = scopeAccess(plane.store, harness.workspace, harness.rootSessionId);
    const command = [
      "printf 'HEAD_SENTINEL\\n'",
      "i=0",
      "while [ \"$i\" -lt 30000 ]; do",
      "  printf 'BODY_%05d_payload_payload\\n' \"$i\"",
      "  if [ \"$i\" -eq 15000 ]; then printf 'MIDDLE_%s\\n' 'BULK_SENTINEL'; fi",
      "  i=$((i + 1))",
      "done",
      "printf 'ERROR_SENTINEL nearby-diagnostic\\n' >&2",
      "printf 'TAIL_SENTINEL\\n' >&2",
    ].join("\n");
    const input = { description: "Emit a recoverable mixed-stream artifact", command };
    const toolCallId = crypto.randomUUID();
    const context = executionContext(harness.childStore, childAccess, "bash", toolCallId);

    harness.childStore.getState().append({ type: "tool-call", toolCallId, toolName: "bash", input });
    const result = await executeRegistered(plane.registry, "bash", input, context);
    harness.childStore.getState().append({ type: "tool-result", toolCallId, toolName: "bash", result });
    await harness.sessions.flushSession(harness.childSessionId, harness.workspace);

    expect(result.isError).toBe(false);
    expect(result.output.preview).toContain("HEAD_SENTINEL");
    // stdout and stderr are independent pipes, so their arrival order cannot
    // determine which stream occupies the bounded head-tail preview. The
    // artifact assertions below verify complete mixed-stream recovery.
    expect(result.output.canonical.bytes).toBeGreaterThan(500 * 1024);
    expect(result.output.preview.length).toBeLessThan(result.output.canonical.bytes / 5);
    expect(result.output.recovery.kind).toBe("artifact");
    if (result.output.recovery.kind !== "artifact") throw new Error("Expected artifact recovery");
    const outputRef = result.output.recovery.outputRef;
    expect(isOutputRef(outputRef)).toBe(true);
    if (!isOutputRef(outputRef)) throw new Error("Expected opaque outputRef");

    const modelJson = JSON.stringify(harness.childStore.getState().toModelMessages());
    expect(modelJson).toContain("HEAD_SENTINEL");
    expect(modelJson).toContain(outputRef);
    expect(modelJson).not.toContain("MIDDLE_BULK_SENTINEL");
    expect(Buffer.byteLength(modelJson)).toBeLessThan(55 * 1024);

    const reloadedSessions = new SessionStoreManager({ logger: silentLogger });
    const persisted = await reloadedSessions.getSessionFile(harness.workspace, harness.childSessionId);
    const persistedJson = JSON.stringify(persisted);
    const fullHistoryJson = JSON.stringify(toModelMessagesFromStoredMessages(persisted.messages, { mode: "full-history" }));
    expect(persistedJson).toContain(outputRef);
    expect(persistedJson).not.toContain("MIDDLE_BULK_SENTINEL");
    expect(Buffer.byteLength(persistedJson)).toBeLessThan(result.output.canonical.bytes / 2);
    expect(fullHistoryJson).toContain(outputRef);
    expect(fullHistoryJson).not.toContain("MIDDLE_BULK_SENTINEL");
    expect(Buffer.byteLength(fullHistoryJson)).toBeLessThan(55 * 1024);

    const searchResult = await executeRegistered(
      plane.registry,
      "output_search",
      { pattern: "ERROR_SENTINEL nearby-diagnostic" },
      executionContext(harness.rootStore, childAccess, "output_search", crypto.randomUUID()),
    );
    expect(searchResult.isError).toBe(false);
    expect(searchResult.output.preview).toContain("ERROR_SENTINEL nearby-diagnostic");
    expect(searchResult.output.preview).toContain(outputRef);

    const firstRead = await executeRegistered(
      plane.registry,
      "output_read",
      { outputRef, limit: 3 },
      executionContext(harness.rootStore, childAccess, "output_read", crypto.randomUUID()),
    );
    expect(firstRead.isError).toBe(false);
    expect(firstRead.output.preview).toContain("HEAD_SENTINEL");
    expect(firstRead.output.recovery.kind).toBe("source");

    const continuous = await readContinuously(childAccess, outputRef);
    expect(continuous.pages).toBeGreaterThan(2);
    expect(continuous.text).toContain("MIDDLE_BULK_SENTINEL");
    expect(continuous.text).toContain("ERROR_SENTINEL nearby-diagnostic");
    expect(continuous.text).toContain("TAIL_SENTINEL");

    await disposeStore(plane.store);
    const reopened = createOutputPlane(harness.artifactRoot);
    const parentAccess = scopeAccess(reopened.store, harness.workspace, harness.rootSessionId);
    const reopenedRead = await readContinuously(parentAccess, outputRef);
    expect(reopenedRead.text).toBe(continuous.text);
    const reopenedFamilySearch = await parentAccess.search({ pattern: "ERROR_SENTINEL nearby-diagnostic", limit: 10 });
    expect(reopenedFamilySearch.matches).toContainEqual(expect.objectContaining({ outputRef }));

    const sameFamilyChildAccess = scopeAccess(reopened.store, harness.workspace, harness.rootSessionId);
    expect((await sameFamilyChildAccess.read({ outputRef, limit: 1 })).outputRef).toBe(outputRef);
    await expect(
      scopeAccess(reopened.store, harness.workspace, crypto.randomUUID()).read({ outputRef }),
    ).rejects.toMatchObject({ code: "TOOL_OUTPUT_FORBIDDEN" });
    const otherProject = join(harness.root, "other-project");
    await mkdir(otherProject);
    await expect(
      scopeAccess(reopened.store, otherProject, harness.rootSessionId).read({ outputRef }),
    ).rejects.toMatchObject({ code: "TOOL_OUTPUT_FORBIDDEN" });

    await disposeStore(reopened.store);
    const childResult = await reopenInChildProcess(outputRef, "ERROR_SENTINEL nearby-diagnostic");
    expect(childResult.pages).toBeGreaterThan(2);
    expect(childResult.canonical).toBe(continuous.text);
    expect(childResult.familyMatches).toContainEqual({
      outputRef,
      snippet: expect.stringContaining("ERROR_SENTINEL nearby-diagnostic"),
    });
  }, 30_000);

  test("retains partial output and strict process details after a real Bash timeout", async () => {
    const plane = createOutputPlane(harness.artifactRoot);
    const access = scopeAccess(plane.store, harness.workspace, harness.rootSessionId);
    const command = [
      "printf 'PARTIAL_SENTINEL\\n'",
      "i=0",
      "while [ \"$i\" -lt 12000 ]; do printf 'TIMEOUT_BODY_%05d_payload\\n' \"$i\"; i=$((i + 1)); done",
      "while :; do :; done",
    ].join("\n");
    const input = {
      description: "Emit partial output before a real timeout",
      command,
      timeoutMs: 350,
    };
    const toolCallId = crypto.randomUUID();
    const context = executionContext(harness.childStore, access, "bash", toolCallId);

    harness.childStore.getState().append({ type: "tool-call", toolCallId, toolName: "bash", input });
    const result = await executeRegistered(plane.registry, "bash", input, context);
    harness.childStore.getState().append({ type: "tool-result", toolCallId, toolName: "bash", result });
    await harness.sessions.flushSession(harness.childSessionId, harness.workspace);

    expect(result.isError).toBe(true);
    expect(result.output.preview).toContain("PARTIAL_SENTINEL");
    expect(result.output.canonical.bytes).toBeGreaterThan(50 * 1024);
    expect(result.details?.error).toMatchObject({ code: "TOOL_BASH_TIMEOUT" });
    expect(result.details?.process).toEqual({
      exitCode: expect.any(Number),
      signal: null,
      timedOut: true,
      aborted: false,
      durationMs: expect.any(Number),
    });
    expect(result.output.recovery.kind).toBe("artifact");
    if (result.output.recovery.kind !== "artifact") throw new Error("Expected timeout artifact recovery");
    const outputRef = result.output.recovery.outputRef;

    const modelJson = JSON.stringify(harness.childStore.getState().toModelMessages());
    expect(modelJson).toContain("PARTIAL_SENTINEL");
    expect(modelJson).toContain("TOOL_BASH_TIMEOUT");
    expect(modelJson).toContain('\\"timedOut\\":true');
    expect(modelJson).toContain(outputRef);
    expect(Buffer.byteLength(modelJson)).toBeLessThan(55 * 1024);

    const search = await access.search({ outputRef, pattern: "PARTIAL_SENTINEL", limit: 10 });
    expect(search.matches).toContainEqual(expect.objectContaining({
      outputRef,
      snippet: expect.stringContaining("PARTIAL_SENTINEL"),
    }));
    const continuous = await readContinuously(access, outputRef);
    expect(continuous.text).toContain("PARTIAL_SENTINEL");
    expect(continuous.text).toContain("EXIT_CODE:");
  }, 10_000);
});

function createOutputPlane(rootDir: string): OutputPlane {
  const store = new ToolOutputArtifactStore({
    rootDir,
    searchRunner: createHermeticArtifactSearchRunner(),
  });
  activeStores.add(store);
  const redactionPolicy = new SecretRedactionPolicy([]);
  const registry = createRegistry({
    finalizer: new ToolOutputFinalizer({ artifactStore: store, redactionPolicy }),
    hitlCodec: new HitlBoundaryCodec(redactionPolicy),
    logger: silentLogger,
  }, [bashTool, outputReadTool, outputSearchTool]);
  return { store, registry };
}

function scopeAccess(
  store: ToolOutputArtifactStore,
  workspaceRoot: string,
  rootSessionId: string,
): ToolOutputAccessService {
  return createScopeBoundToolOutputAccess(store, { workspaceRoot, rootSessionId });
}

function executionContext(
  store: StoryHarness["childStore"],
  outputArtifacts: ToolOutputAccessService,
  toolName: string,
  toolCallId: string,
): ToolExecutionContext {
  return {
    store,
    storeManager: harness.sessions,
    toolName,
    toolCallId,
    input: {},
    step: 1,
    abort: new AbortController().signal,
    agentName: store.getState().agentName,
    startedAt: Date.now(),
    allowedTools: TOOL_NAMES,
    projectContext: createTestProjectContext(harness.workspace, harness.sessions),
    cwd: harness.workspace,
    outputArtifacts,
    currentDepth: 0,
  };
}

function beginUserRound(store: StoryHarness["rootStore"], text: string): void {
  const executionId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  store.getState().append(testExecutionStart(executionId, "user_message"));
  store.getState().append({
    type: "session.messages_committed",
    executionId,
    messages: [{
      id: messageId,
      role: "user",
      parts: [{ type: "text", id: `${messageId}:text`, text, createdAt: 1, completedAt: 1 }],
      createdAt: 1,
      completedAt: 1,
      executionId,
      clientRequestId: `request-${messageId}`,
    }],
  });
}

function appendCompletedRound(store: StoryHarness["rootStore"], userText: string, assistantText: string): void {
  beginUserRound(store, userText);
  store.getState().append({ type: "text-start" });
  store.getState().append({ type: "text-delta", text: assistantText });
  store.getState().append({ type: "text-end" });
  store.getState().append({ type: "execution-end", status: "completed" });
}

async function executeRegistered(
  registry: ToolRegistry,
  toolName: string,
  input: unknown,
  context: ToolExecutionContext,
): Promise<FinalizedToolResult> {
  const toolCall = { toolCallId: context.toolCallId, toolName, input };
  const first = await registry.execute(toolCall, context);
  const outcome = first.kind === "blocked"
    ? await registry.resumeBlocked({
        toolCall,
        request: first.request,
        requestKey: first.requestKey,
        response: { type: "permission_decision", decision: "approve_once" },
        context,
      })
    : first;
  return expectSettledResult(outcome);
}

async function readContinuously(
  access: ToolOutputAccessService,
  outputRef: string,
): Promise<{ readonly text: string; readonly pages: number }> {
  let cursor: string | undefined;
  let expectedStart = 0;
  let pages = 0;
  let text = "";

  do {
    const page = await access.read({
      outputRef,
      ...(cursor === undefined ? {} : { cursor }),
      limit: 1_000,
      maxContentBytes: 42 * 1024,
    });
    expect(page.completeness).toBe("complete");
    expect(page.gap).toBeUndefined();
    let contiguous = true;
    for (const record of page.records) {
      if (record.canonicalStart !== expectedStart) contiguous = false;
      expectedStart = record.canonicalEnd;
      text += record.text;
    }
    expect(contiguous).toBe(true);
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor !== undefined);

  return { text, pages };
}

async function disposeStore(store: ToolOutputArtifactStore): Promise<void> {
  activeStores.delete(store);
  await store.dispose();
}

async function reopenInChildProcess(
  outputRef: string,
  pattern: string,
): Promise<{
  readonly canonical: string;
  readonly pages: number;
  readonly familyMatches: Array<{ readonly outputRef: string; readonly snippet: string }>;
}> {
  const result = await createProcessRunner().run({
    argv: [
      process.execPath,
      CHILD_REOPEN_FIXTURE,
      harness.artifactRoot,
      harness.workspace,
      harness.rootSessionId,
      outputRef,
      pattern,
    ],
    cwd: harness.workspace,
    env: {
      PATH: Bun.env.PATH,
      LANG: Bun.env.LANG,
    },
    stdin: null,
    timeoutMs: 15_000,
  });
  if (result.kind === "spawn-failure") {
    throw new Error(`Artifact reopen child failed: spawn-failure ${result.error.message}`);
  }
  if (result.kind !== "success") {
    throw new Error(`Artifact reopen child failed: ${result.kind} ${result.output.stderr}`);
  }
  return JSON.parse(result.output.stdout);
}
