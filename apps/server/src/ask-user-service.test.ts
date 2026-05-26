import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AskUserRequest } from "@specra/agent-core";
import { SessionStoreManager } from "@specra/agent-core";
import { AskUserService } from "./ask-user-service";

const tmpRoots: string[] = [];
const manager = new SessionStoreManager();

const request: AskUserRequest = {
  toolName: "ask_user",
  toolCallId: "call-1",
  abortSignal: new AbortController().signal,
  questions: [
    {
      question: "Which option?",
      header: "Choice",
      options: [{ label: "Yes", description: "Approve" }],
      custom: true,
    },
  ],
};

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function createWorkspaceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "specra-ask-user-service-"));
  tmpRoots.push(root);
  return root;
}

async function createPending() {
  const service = new AskUserService();
  const sessionId = `session-${crypto.randomUUID()}`;
  const workspaceRoot = await createWorkspaceRoot();
  const store = manager.create(sessionId, workspaceRoot);
  const promise = service.request(sessionId, workspaceRoot, request, store);
  const event = store.getState().events.find((entry) => entry.kind === "question.request");
  if (!event) {
    throw new Error("question request event missing");
  }

  const payload = event.payload as { questionId: string; question: string };

  return { service, store, workspaceRoot, promise, id: payload.questionId, payload };
}

describe("AskUserService", () => {
  afterEach(() => {
    manager.clearAll();
  });

  test("request creates Deferred, respond resolves it with answers", async () => {
    const { service, promise, id, payload, store } = await createPending();

    expect(service.has(id)).toBe(true);
    expect(payload.questionId).toBe(id);
    expect(JSON.parse(payload.question)).toMatchObject({
      toolName: request.toolName,
      toolCallId: request.toolCallId,
      questions: request.questions,
    });

    expect(service.respond(id, { answers: [["Yes"]] })).toBe(true);
    await expect(promise).resolves.toEqual({ answers: [["Yes"]] });
    expect(service.has(id)).toBe(false);
    expect(store.getState().events.map((event) => event.kind)).toEqual([
      "question.request",
      "question.terminal",
    ]);
    expect(store.getState().events[1]?.payload).toMatchObject({
      questionId: id,
      status: "resolved",
      answer: JSON.stringify([["Yes"]]),
    });
  });

  test("respond resolves it with error", async () => {
    const { service, promise, id } = await createPending();

    expect(service.respond(id, { isError: true, reason: "No answer" })).toBe(true);

    await expect(promise).resolves.toEqual({ isError: true, reason: "No answer" });
    expect(service.has(id)).toBe(false);
  });

  test("abort signal triggers cleanup and resolves with Cancelled", async () => {
    const service = new AskUserService();
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceRoot = await createWorkspaceRoot();
    const store = manager.create(sessionId, workspaceRoot);
    const abortController = new AbortController();
    const promise = service.request(sessionId, workspaceRoot, request, store, abortController.signal);
    const event = store.getState().events.find((entry) => entry.kind === "question.request");
    if (!event) {
      throw new Error("question request event missing");
    }

    const payload = event.payload as { questionId: string };

    abortController.abort();
    await flushMicrotasks();

    await expect(promise).resolves.toEqual({ isError: true, reason: "Cancelled" });
    expect(service.has(payload.questionId)).toBe(false);
    expect(service.respond(payload.questionId, { answers: [["Yes"]] })).toBe(false);
    expect(store.getState().events[1]?.payload).toMatchObject({
      questionId: payload.questionId,
      status: "cancelled",
    });
  });

  test("cleanup resolves pending questions for a session", async () => {
    const service = new AskUserService();
    const sessionOne = `session-${crypto.randomUUID()}`;
    const sessionTwo = `session-${crypto.randomUUID()}`;
    const workspaceOne = await createWorkspaceRoot();
    const workspaceTwo = await createWorkspaceRoot();
    const storeOne = manager.create(sessionOne, workspaceOne);
    const storeTwo = manager.create(sessionTwo, workspaceTwo);
    const first = service.request(sessionOne, workspaceOne, request, storeOne);
    const second = service.request(sessionTwo, workspaceTwo, request, storeTwo);
    const firstEvent = storeOne.getState().events.find((entry) => entry.kind === "question.request");
    const secondEvent = storeTwo.getState().events.find((entry) => entry.kind === "question.request");
    if (!firstEvent || !secondEvent) {
      throw new Error("question request event missing");
    }

    const firstId = (firstEvent.payload as { questionId: string }).questionId;
    const secondId = (secondEvent.payload as { questionId: string }).questionId;

    service.cleanup(sessionOne);

    expect(service.has(firstId)).toBe(false);
    expect(service.has(secondId)).toBe(true);
    await expect(first).resolves.toEqual({ isError: true, reason: "Cancelled" });
    expect(storeOne.getState().events[1]?.payload).toMatchObject({
      questionId: firstId,
      status: "cancelled",
    });

    expect(service.respond(secondId, { answers: [["Later"]] })).toBe(true);
    await expect(second).resolves.toEqual({ answers: [["Later"]] });
    expect(storeTwo.getState().events[1]?.payload).toMatchObject({
      questionId: secondId,
      status: "resolved",
      answer: JSON.stringify([["Later"]]),
    });
  });

  test("cleanup without sessionId resolves all pending questions", async () => {
    const service = new AskUserService();
    const sessionOne = `session-${crypto.randomUUID()}`;
    const sessionTwo = `session-${crypto.randomUUID()}`;
    const workspaceOne = await createWorkspaceRoot();
    const workspaceTwo = await createWorkspaceRoot();
    const storeOne = manager.create(sessionOne, workspaceOne);
    const storeTwo = manager.create(sessionTwo, workspaceTwo);
    const first = service.request(sessionOne, workspaceOne, request, storeOne);
    const second = service.request(sessionTwo, workspaceTwo, request, storeTwo);
    const firstEvent = storeOne.getState().events.find((entry) => entry.kind === "question.request");
    const secondEvent = storeTwo.getState().events.find((entry) => entry.kind === "question.request");
    if (!firstEvent || !secondEvent) {
      throw new Error("question request event missing");
    }

    const firstId = (firstEvent.payload as { questionId: string }).questionId;
    const secondId = (secondEvent.payload as { questionId: string }).questionId;

    service.cleanup();

    expect(service.has(firstId)).toBe(false);
    expect(service.has(secondId)).toBe(false);
    await expect(first).resolves.toEqual({ isError: true, reason: "Cancelled" });
    await expect(second).resolves.toEqual({ isError: true, reason: "Cancelled" });
    expect(storeOne.getState().events[1]?.payload).toMatchObject({
      questionId: firstId,
      status: "cancelled",
    });
    expect(storeTwo.getState().events[1]?.payload).toMatchObject({
      questionId: secondId,
      status: "cancelled",
    });
  });

  test("respond to non-existent id returns false", () => {
    const service = new AskUserService();

    expect(service.respond("missing", { answers: [["Yes"]] })).toBe(false);
  });

  test("has returns true while pending and false after resolve", async () => {
    const { service, promise, id } = await createPending();

    expect(service.has(id)).toBe(true);
    expect(service.respond(id, { answers: [["Yes"]] })).toBe(true);

    await promise;
    expect(service.has(id)).toBe(false);
  });

  test("cleanup with workspaceRoot only clears matching entries", async () => {
    const service = new AskUserService();
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceA = await createWorkspaceRoot();
    const workspaceB = await createWorkspaceRoot();
    const storeA = manager.create(sessionId, workspaceA);
    const storeB = manager.create(sessionId, workspaceB);
    const first = service.request(sessionId, workspaceA, request, storeA);
    const second = service.request(sessionId, workspaceB, request, storeB);
    const firstEvent = storeA.getState().events.find((entry) => entry.kind === "question.request");
    const secondEvent = storeB.getState().events.find((entry) => entry.kind === "question.request");
    if (!firstEvent || !secondEvent) {
      throw new Error("question request event missing");
    }

    const firstId = (firstEvent.payload as { questionId: string }).questionId;
    const secondId = (secondEvent.payload as { questionId: string }).questionId;

    service.cleanup(sessionId, workspaceA);

    expect(service.has(firstId)).toBe(false);
    expect(service.has(secondId)).toBe(true);
    await expect(first).resolves.toEqual({ isError: true, reason: "Cancelled" });
    expect(storeA.getState().events[1]?.payload).toMatchObject({
      questionId: firstId,
      status: "cancelled",
    });

    expect(service.respond(secondId, { answers: [["Later"]] })).toBe(true);
    await expect(second).resolves.toEqual({ answers: [["Later"]] });
    expect(storeB.getState().events[1]?.payload).toMatchObject({
      questionId: secondId,
      status: "resolved",
      answer: JSON.stringify([["Later"]]),
    });
  });
});

afterAll(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
});
