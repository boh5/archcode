import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpecraRuntime } from "@specra/agent-core";
import type { GlobalSSEEvent, GlobalSessionEventEnvelope, SessionEventPayload } from "@specra/protocol";
import { createSpecraRuntime } from "@specra/agent-core";
import type { McpDiscoveryResult, McpManager } from "../../../packages/agent-core/src/mcp/index";
import { __setSessionsDirForTest } from "../../../packages/agent-core/src/store/sessions-dir";
import { storeManager } from "../../../packages/agent-core/src/store/store";
import { createRegistry } from "../../../packages/agent-core/src/tools/registry";
import { createServerApp } from "./app";
import { globalEventBus } from "./events/global-event-bus";

const roots: string[] = [];

interface Fixture {
  runtime: SpecraRuntime;
  app: ReturnType<typeof createServerApp>["app"];
  workspaceRoot: string;
  sessionId: string;
  slug: string;
  sessionEvents: GlobalSSEEvent[];
  unsubscribeBridge: () => void;
}

interface ParsedSseFrame {
  event: string;
  data: GlobalSSEEvent;
}

type SessionEventByKind<K extends SessionEventPayload["type"]> = GlobalSessionEventEnvelope<Extract<SessionEventPayload, { type: K }>>;

beforeEach(() => {
  storeManager.clearAll();
});

afterEach(() => {
  __setSessionsDirForTest(undefined);
  storeManager.clearAll();
});

afterAll(async () => {
  __setSessionsDirForTest(undefined);
  storeManager.clearAll();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("deferred events integration", () => {
  test("permission request is visible on runtime session events and global SSE, then approve resolves terminal event", async () => {
    const fixture = await createFixture();
    const response = await fixture.app.request("/api/events");
    const requestPromise = fixture.runtime.requestPermission(fixture.workspaceRoot, fixture.sessionId, {
      toolName: "bash",
      toolCallId: "call-1",
      input: { command: "pwd" },
      description: "Run command",
    });

    const globalRequest = await readUntilEvent(response, (event) => event.kind === "permission.request");
    expect(globalRequest.event).toBe("event");
    expect(globalRequest.data).toMatchObject({
      type: "event",
      slug: fixture.slug,
      sessionId: fixture.sessionId,
      kind: "permission.request",
      payload: {
        type: "permission.request",
        toolName: "bash",
        args: { command: "pwd" },
      },
    });
    expect(Object.keys((globalRequest.data as GlobalSessionEventEnvelope).payload)).toEqual([
      "type",
      "permissionId",
      "toolName",
      "args",
      "description",
    ]);

    const requestEvent = expectSingleSessionEvent(fixture.sessionEvents, "permission.request");
    const permissionId = requestEvent.payload.permissionId;
    expect(requestEvent.type).toBe("event");
    expect(requestEvent.kind).toBe("permission.request");
    expect(requestEvent.payload).toMatchObject({
      type: "permission.request",
      permissionId: expect.any(String),
      toolName: "bash",
      args: { command: "pwd" },
    });

    const routeResponse = await fixture.app.request(`/api/permissions/${permissionId}`, {
      method: "POST",
      body: JSON.stringify({ response: "approve_once" }),
      headers: { "content-type": "application/json" },
    });

    expect(routeResponse.status).toBe(200);
    await expect(requestPromise).resolves.toBe("approve_once");
    const terminal = expectLastSessionEvent(fixture.sessionEvents, "permission.terminal");
    expect(terminal.payload).toEqual({
      type: "permission.terminal",
      permissionId,
      status: "resolved",
    });
    fixture.unsubscribeBridge();
  });

  test("permission terminal events cover denied, timeout, and cancelled statuses", async () => {
    const denied = await createFixture();
    const deniedPromise = denied.runtime.requestPermission(denied.workspaceRoot, denied.sessionId, permissionRequest("deny-call"));
    const deniedId = expectLastSessionEvent(denied.sessionEvents, "permission.request").payload.permissionId;
    const deniedResponse = await denied.app.request(`/api/permissions/${deniedId}`, {
      method: "POST",
      body: JSON.stringify({ response: "deny" }),
      headers: { "content-type": "application/json" },
    });
    expect(deniedResponse.status).toBe(200);
    await expect(deniedPromise).resolves.toBe("deny");
    expect(expectLastSessionEvent(denied.sessionEvents, "permission.terminal").payload).toEqual({
      type: "permission.terminal",
      permissionId: deniedId,
      status: "denied",
    });
    denied.unsubscribeBridge();

    const timedOut = await createFixture();
    const abortController = new AbortController();
    const timeoutPromise = timedOut.runtime.requestPermission(
      timedOut.workspaceRoot,
      timedOut.sessionId,
      permissionRequest("timeout-call"),
      abortController.signal,
    );
    const timeoutId = expectLastSessionEvent(timedOut.sessionEvents, "permission.request").payload.permissionId;
    abortController.abort();
    await expect(timeoutPromise).resolves.toBe("timeout");
    expect(expectLastSessionEvent(timedOut.sessionEvents, "permission.terminal").payload).toEqual({
      type: "permission.terminal",
      permissionId: timeoutId,
      status: "timeout",
    });
    timedOut.unsubscribeBridge();

    const cancelled = await createFixture();
    const cancelledPromise = cancelled.runtime.requestPermission(cancelled.workspaceRoot, cancelled.sessionId, permissionRequest("cancel-call"));
    const cancelledId = expectLastSessionEvent(cancelled.sessionEvents, "permission.request").payload.permissionId;
    cancelled.runtime.cleanupDeferredSession(cancelled.workspaceRoot, cancelled.sessionId);
    await expect(cancelledPromise).resolves.toBe("timeout");
    expect(expectLastSessionEvent(cancelled.sessionEvents, "permission.terminal").payload).toEqual({
      type: "permission.terminal",
      permissionId: cancelledId,
      status: "cancelled",
    });
    cancelled.unsubscribeBridge();
  });

  test("question request is visible on global SSE and answer route emits resolved terminal event", async () => {
    const fixture = await createFixture();
    const response = await fixture.app.request("/api/events");
    const questionPromise = fixture.runtime.requestQuestion(fixture.workspaceRoot, fixture.sessionId, {
      toolName: "ask_user",
      toolCallId: "ask-1",
      questions: [{ question: "Proceed?", header: "Confirm", options: [], custom: true }],
    });

    const globalRequest = await readUntilEvent(response, (event) => event.kind === "question.request");
    expect(globalRequest.data).toMatchObject({
      type: "event",
      slug: fixture.slug,
      sessionId: fixture.sessionId,
      kind: "question.request",
      payload: {
        type: "question.request",
        questionId: expect.any(String),
        question: expect.any(String),
      },
    });

    const request = expectLastSessionEvent(fixture.sessionEvents, "question.request");
    const questionId = request.payload.questionId;
    const parsedQuestion = JSON.parse(request.payload.question) as Record<string, unknown>;
    expect(parsedQuestion).toMatchObject({ toolName: "ask_user", toolCallId: "ask-1" });

    const routeResponse = await fixture.app.request(`/api/questions/${questionId}`, {
      method: "POST",
      body: JSON.stringify({ answers: [["Yes", "Ship it"]] }),
      headers: { "content-type": "application/json" },
    });

    expect(routeResponse.status).toBe(200);
    await expect(questionPromise).resolves.toEqual({ answers: [["Yes", "Ship it"]] });
    const terminal = expectLastSessionEvent(fixture.sessionEvents, "question.terminal");
    expect(terminal.kind).toBe("question.terminal");
    expect(terminal.payload).toEqual({
      type: "question.terminal",
      questionId,
      status: "resolved",
      answer: JSON.stringify([["Yes", "Ship it"]]),
    });
    if (terminal.payload.answer === undefined) throw new Error("Expected serialized question answer");
    expect(JSON.parse(terminal.payload.answer)).toEqual([["Yes", "Ship it"]]);
    fixture.unsubscribeBridge();
  });

  test("question terminal events cover denied and cancelled statuses", async () => {
    const denied = await createFixture();
    const deniedPromise = denied.runtime.requestQuestion(denied.workspaceRoot, denied.sessionId, questionRequest("denied-question"));
    const deniedId = expectLastSessionEvent(denied.sessionEvents, "question.request").payload.questionId;
    const deniedResponse = await denied.app.request(`/api/questions/${deniedId}`, {
      method: "POST",
      body: JSON.stringify({ isError: true, reason: "No answer" }),
      headers: { "content-type": "application/json" },
    });
    expect(deniedResponse.status).toBe(200);
    await expect(deniedPromise).resolves.toEqual({ isError: true, reason: "No answer" });
    expect(expectLastSessionEvent(denied.sessionEvents, "question.terminal").payload).toEqual({
      type: "question.terminal",
      questionId: deniedId,
      status: "denied",
      answer: undefined,
    });
    denied.unsubscribeBridge();

    const cancelled = await createFixture();
    const cancelledPromise = cancelled.runtime.requestQuestion(cancelled.workspaceRoot, cancelled.sessionId, questionRequest("cancelled-question"));
    const cancelledId = expectLastSessionEvent(cancelled.sessionEvents, "question.request").payload.questionId;
    cancelled.runtime.cleanupDeferredSession(cancelled.workspaceRoot, cancelled.sessionId);
    await expect(cancelledPromise).resolves.toEqual({ isError: true, reason: "Cancelled" });
    expect(expectLastSessionEvent(cancelled.sessionEvents, "question.terminal").payload).toEqual({
      type: "question.terminal",
      questionId: cancelledId,
      status: "cancelled",
    });
    cancelled.unsubscribeBridge();
  });

  test("runtime shutdown is emitted through the core-owned session event boundary", async () => {
    const fixture = await createFixture();
    const response = await fixture.app.request("/api/events");
    const pending = fixture.runtime.requestPermission(fixture.workspaceRoot, fixture.sessionId, permissionRequest("shutdown-call"));
    expectLastSessionEvent(fixture.sessionEvents, "permission.request");

    fixture.runtime.notifyRuntimeShutdown("server_shutdown");

    const shutdown = expectLastSessionEvent(fixture.sessionEvents, "shutdown");
    expect(shutdown).toMatchObject({
      type: "event",
      slug: fixture.slug,
      sessionId: fixture.sessionId,
      kind: "shutdown",
      payload: { type: "shutdown", reason: "server_shutdown" },
    });
    const globalShutdown = await readUntilEvent(response, (event) => event.kind === "shutdown");
    expect(globalShutdown.data).toMatchObject({
      type: "event",
      kind: "shutdown",
      payload: { type: "shutdown", reason: "server_shutdown" },
    });

    fixture.runtime.cleanupDeferredSession(fixture.workspaceRoot, fixture.sessionId);
    await pending;
    fixture.unsubscribeBridge();
  });
});

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "specra-deferred-events-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  __setSessionsDirForTest((requestedWorkspaceRoot) => join(requestedWorkspaceRoot, ".test-sessions"));
  expect(createRegistry([]).getAll()).toEqual([]);

  const configPath = await writeConfig(root);
  const runtime = await createSpecraRuntime({
    configPath,
    workspaceRoot,
    mcpManagerFactory: () => makeFakeMcpManager(),
  });
  const { app } = createServerApp(runtime, { dev: true });
  const session = await runtime.createSession(workspaceRoot);
  const sessionEvents: GlobalSSEEvent[] = [];
  const slug = `project-${crypto.randomUUID()}`;
  const unsubscribeBridge = runtime.subscribeSessionEvents({
    slug,
    workspaceRoot,
    sessionId: session.sessionId,
    onEvent: (event) => {
      sessionEvents.push(event);
      globalEventBus.emit(event);
    },
  });

  return { runtime, app, workspaceRoot, sessionId: session.sessionId, slug, sessionEvents, unsubscribeBridge };
}

async function writeConfig(root: string): Promise<string> {
  const configPath = join(root, ".specra.json");
  await Bun.write(configPath, JSON.stringify({
    provider: {
      local: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local Test",
        options: { baseURL: "http://localhost:8090/v1", apiKey: "test-key" },
        models: {
          "test-model": {
            name: "Test Model",
            limit: { context: 4096, output: 1024 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
    agents: {
      orchestrator: { model: "local:test-model" },
      explore: { model: "local:test-model" },
    },
    mcp: { servers: {} },
  }));
  return configPath;
}

function makeFakeMcpManager(): McpManager {
  return {
    discover: mock(async (): Promise<McpDiscoveryResult> => ({ descriptors: [], warnings: [] })),
    closeAll: mock(async () => []),
  } as unknown as McpManager;
}

function permissionRequest(toolCallId: string) {
  return {
    toolName: "bash",
    toolCallId,
    input: { command: "pwd" },
    description: "Run command",
  };
}

function questionRequest(toolCallId: string) {
  return {
    toolName: "ask_user",
    toolCallId,
    questions: [{ question: "Proceed?", header: "Confirm", options: [], custom: true }],
  };
}

function expectSingleSessionEvent<K extends SessionEventPayload["type"]>(
  events: GlobalSSEEvent[],
  kind: K,
): SessionEventByKind<K> {
  const matches = events.filter((event): event is SessionEventByKind<K> => isSessionEventKind(event, kind));
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function expectLastSessionEvent<K extends SessionEventPayload["type"]>(
  events: GlobalSSEEvent[],
  kind: K,
): SessionEventByKind<K> {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (isSessionEventKind(event, kind)) return event;
  }
  throw new Error(`Expected session event ${kind}`);
}

function isSessionEventKind<K extends SessionEventPayload["type"]>(
  event: GlobalSSEEvent,
  kind: K,
): event is SessionEventByKind<K> {
  return event.type === "event" && event.kind === kind;
}

async function readUntilEvent(
  response: Response,
  predicate: (event: GlobalSessionEventEnvelope) => boolean,
): Promise<ParsedSseFrame> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Expected SSE response body");

  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 2000;

  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const result = await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((_resolve, reject) => {
          setTimeout(() => reject(new Error("Timed out reading SSE response")), remaining);
        }),
      ]);
      if (result.done) break;
      text += decoder.decode(result.value, { stream: true });

      for (const frame of parseSseFrames(text)) {
        if (frame.data.type === "event" && predicate(frame.data)) return frame;
      }
    }
  } finally {
    await reader.cancel();
  }

  throw new Error(`SSE predicate was not satisfied. Received: ${text}`);
}

function parseSseFrames(text: string): ParsedSseFrame[] {
  const frames: ParsedSseFrame[] = [];
  for (const rawFrame of text.split("\n\n")) {
    if (!rawFrame.trim()) continue;
    const eventLine = rawFrame.split("\n").find((line) => line.startsWith("event: "));
    const dataLine = rawFrame.split("\n").find((line) => line.startsWith("data: "));
    if (!eventLine || !dataLine) continue;
    frames.push({ event: eventLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) as GlobalSSEEvent });
  }
  return frames;
}
