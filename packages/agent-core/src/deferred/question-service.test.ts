import { afterEach, describe, expect, test } from "bun:test";
import type { AskUserRequest } from "../tools/types";
import { SessionStoreManager } from "../store/session-store-manager";
import { silentLogger } from "../logger";
import { DeferredQuestionService } from "./question-service";
import type { AskUserResponse, DeferredSessionEvent } from "./types";

const manager = new SessionStoreManager({ logger: silentLogger });

const request: AskUserRequest = {
  toolName: "ask_user",
  toolCallId: "call-1",
  questionType: "decision",
  context: { blockers: ["missing requirement"] },
  questions: [
    {
      question: "Which option?",
      header: "Choice",
      options: [{ label: "Yes", description: "Approve" }],
      custom: true,
    },
  ],
};

const CANCELLED_RESPONSE: AskUserResponse = { isError: true, reason: "Cancelled" };

function createService() {
  const sessionId = `session-${crypto.randomUUID()}`;
  const workspaceRoot = `/tmp/archcode-deferred-question-${crypto.randomUUID()}`;
  const store = manager.create(sessionId, workspaceRoot);
  const service = new DeferredQuestionService({
    submitDeferredEvent(root: string, id: string, event: DeferredSessionEvent) {
      manager.get(id, root)?.getState().append(event);
    },
  });

  return { service, sessionId, workspaceRoot, store };
}

function requestQuestion(response?: AskUserResponse) {
  const current = createService();
  const promise = current.service.request(current.sessionId, current.workspaceRoot, request);
  const event = current.store.getState().events.find((entry) => entry.kind === "question.request");
  if (event?.payload.type !== "question.request") throw new Error("question request event missing");

  if (response) current.service.respond(event.payload.questionId, response);
  return { ...current, promise, questionId: event.payload.questionId, payload: event.payload };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("DeferredQuestionService", () => {
  afterEach(() => manager.clearAll());

  test("resolved answer appends terminal event with serialized answer", async () => {
    const { service, promise, questionId, payload, store } = requestQuestion();

    expect(service.has(questionId)).toBe(true);
    expect(JSON.parse(payload.question)).toMatchObject({
      toolName: request.toolName,
      toolCallId: request.toolCallId,
      questionType: "decision",
      context: { blockers: ["missing requirement"] },
      questions: request.questions,
    });
    expect(payload.questionType).toBe("decision");
    expect(payload.context).toEqual({ blockers: ["missing requirement"] });

    expect(service.respond(questionId, { answers: [["Yes"]] })).toBe(true);
    await expect(promise).resolves.toEqual({ answers: [["Yes"]] });
    expect(service.has(questionId)).toBe(false);
    expect(store.getState().events.map((event) => event.kind)).toEqual([
      "question.request",
      "question.terminal",
    ]);
    expect(store.getState().events.at(-1)?.payload).toMatchObject({
      type: "question.terminal",
      questionId,
      status: "resolved",
      answer: JSON.stringify([["Yes"]]),
    });
  });

  test("error response resolves and appends denied terminal event", async () => {
    const { promise, store, questionId } = requestQuestion({ isError: true, reason: "No answer" });

    await expect(promise).resolves.toEqual({ isError: true, reason: "No answer" });
    expect(store.getState().events.at(-1)?.payload).toMatchObject({ questionId, status: "denied" });
  });

  test("pre-aborted request appends cancelled terminal event", async () => {
    const { service, sessionId, workspaceRoot, store } = createService();
    const abortController = new AbortController();
    abortController.abort();

    const promise = service.request(sessionId, workspaceRoot, { ...request, abortSignal: abortController.signal });

    await expect(promise).resolves.toEqual(CANCELLED_RESPONSE);
    expect(store.getState().events.map((event) => event.kind)).toEqual([
      "question.request",
      "question.terminal",
    ]);
    expect(store.getState().events.at(-1)?.payload).toMatchObject({ status: "cancelled" });
  });

  test("abort signal resolves cancelled and appends cancelled terminal event", async () => {
    const { service, sessionId, workspaceRoot, store } = createService();
    const abortController = new AbortController();
    const promise = service.request(sessionId, workspaceRoot, { ...request, abortSignal: abortController.signal });
    const event = store.getState().events.find((entry) => entry.kind === "question.request");
    if (event?.payload.type !== "question.request") throw new Error("question request event missing");

    abortController.abort();
    await flushMicrotasks();

    await expect(promise).resolves.toEqual(CANCELLED_RESPONSE);
    expect(service.has(event.payload.questionId)).toBe(false);
    expect(service.respond(event.payload.questionId, { answers: [["Yes"]] })).toBe(false);
    expect(store.getState().events.at(-1)?.payload).toMatchObject({
      questionId: event.payload.questionId,
      status: "cancelled",
    });
  });

  test("cleanup resolves cancelled and appends cancelled terminal event", async () => {
    const { service, promise, questionId, store, sessionId, workspaceRoot } = requestQuestion();

    service.cleanup(sessionId, workspaceRoot);

    await expect(promise).resolves.toEqual(CANCELLED_RESPONSE);
    expect(service.has(questionId)).toBe(false);
    expect(store.getState().events.at(-1)?.payload).toMatchObject({
      type: "question.terminal",
      questionId,
      status: "cancelled",
    });
  });

  test("respond to missing question returns false", () => {
    const { service } = createService();

    expect(service.respond("missing", { answers: [["Yes"]] })).toBe(false);
  });
});
