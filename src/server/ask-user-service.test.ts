import { describe, expect, test } from "bun:test";
import type { AskUserRequest } from "../tools/types";
import { AskUserService } from "./ask-user-service";
import { EventRing } from "./event-ring";

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

async function createPending() {
  const service = new AskUserService();
  const ring = new EventRing();
  const promise = service.request("session-1", request, ring);
  const event = ring.since(0)[0];
  const payload = JSON.parse(event.data) as { id: string; sessionId: string; abortSignal?: unknown };

  return { service, ring, promise, id: payload.id, payload };
}

describe("AskUserService", () => {
  test("request creates Deferred, respond resolves it with answers", async () => {
    const { service, promise, id, payload } = await createPending();

    expect(service.has(id)).toBe(true);
    expect(payload.sessionId).toBe("session-1");
    expect(payload.id).toBe(id);
    expect(payload.abortSignal).toBeUndefined();
    expect(payload).toMatchObject({
      toolName: request.toolName,
      toolCallId: request.toolCallId,
      questions: request.questions,
    });

    expect(service.respond(id, { answers: [["Yes"]] })).toBe(true);
    await expect(promise).resolves.toEqual({ answers: [["Yes"]] });
    expect(service.has(id)).toBe(false);
  });

  test("respond resolves it with error", async () => {
    const { service, promise, id } = await createPending();

    expect(service.respond(id, { isError: true, reason: "No answer" })).toBe(true);

    await expect(promise).resolves.toEqual({ isError: true, reason: "No answer" });
    expect(service.has(id)).toBe(false);
  });

  test("abort signal triggers cleanup and resolves with Cancelled", async () => {
    const service = new AskUserService();
    const ring = new EventRing();
    const abortController = new AbortController();
    const promise = service.request("session-1", request, ring, abortController.signal);
    const payload = JSON.parse(ring.since(0)[0].data) as { id: string };

    abortController.abort();
    await flushMicrotasks();

    await expect(promise).resolves.toEqual({ isError: true, reason: "Cancelled" });
    expect(service.has(payload.id)).toBe(false);
    expect(service.respond(payload.id, { answers: [["Yes"]] })).toBe(false);
  });

  test("cleanup resolves pending questions for a session", async () => {
    const service = new AskUserService();
    const ringOne = new EventRing();
    const ringTwo = new EventRing();
    const first = service.request("session-1", request, ringOne);
    const second = service.request("session-2", request, ringTwo);
    const firstId = (JSON.parse(ringOne.since(0)[0].data) as { id: string }).id;
    const secondId = (JSON.parse(ringTwo.since(0)[0].data) as { id: string }).id;

    service.cleanup("session-1");

    expect(service.has(firstId)).toBe(false);
    expect(service.has(secondId)).toBe(true);
    await expect(first).resolves.toEqual({ isError: true, reason: "Cancelled" });

    expect(service.respond(secondId, { answers: [["Later"]] })).toBe(true);
    await expect(second).resolves.toEqual({ answers: [["Later"]] });
  });

  test("cleanup without sessionId resolves all pending questions", async () => {
    const service = new AskUserService();
    const ringOne = new EventRing();
    const ringTwo = new EventRing();
    const first = service.request("session-1", request, ringOne);
    const second = service.request("session-2", request, ringTwo);
    const firstId = (JSON.parse(ringOne.since(0)[0].data) as { id: string }).id;
    const secondId = (JSON.parse(ringTwo.since(0)[0].data) as { id: string }).id;

    service.cleanup();

    expect(service.has(firstId)).toBe(false);
    expect(service.has(secondId)).toBe(false);
    await expect(first).resolves.toEqual({ isError: true, reason: "Cancelled" });
    await expect(second).resolves.toEqual({ isError: true, reason: "Cancelled" });
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
});
