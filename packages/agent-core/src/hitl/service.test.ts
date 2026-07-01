import { describe, expect, test } from "bun:test";
import { HitlService } from "./service";
import type { HitlEvent, HitlPayload, HitlResponsePayload, HitlTrigger } from "./types";

const basePayload: HitlPayload = {
  title: "Approve plan",
  message: "The Goal is ready to move from plan to build.",
  details: { phase: "plan" },
};

const baseTrigger: HitlTrigger = {
  projectSlug: "archcode",
  goalId: "goal-1",
  loopId: "loop-1",
  source: "goal.approvalPoint.after_plan",
};

const approvePayload: HitlResponsePayload = {
  decision: "approve",
  comment: "Looks good",
};

function createService() {
  const events: Array<{ sessionId: string; event: HitlEvent }> = [];
  const service = new HitlService({
    submitHitlEvent(sessionId: string, event: HitlEvent) {
      events.push({ sessionId, event });
    },
  });

  return { service, events, sessionId: `session-${crypto.randomUUID()}` };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("HitlService", () => {
  test("request creates a pending approval and emits hitl.request", () => {
    const { service, events, sessionId } = createService();

    const promise = service.request(sessionId, "approval", basePayload, baseTrigger);
    const requestEvent = events.at(0)?.event;
    if (requestEvent?.type !== "hitl.request") throw new Error("hitl request event missing");

    expect(service.has(requestEvent.hitlId)).toBe(true);
    expect(service.listPending()).toHaveLength(1);
    expect(service.listPending("archcode", "goal-1", "loop-1")).toHaveLength(1);
    expect(requestEvent).toMatchObject({
      type: "hitl.request",
      sessionId,
      kind: "approval",
      payload: basePayload,
      trigger: baseTrigger,
    });

    service.cancel(requestEvent.hitlId, "test cleanup");
    return expect(promise).resolves.toMatchObject({ status: "cancelled" });
  });

  test("respond resolves the request promise and emits hitl.resolved", async () => {
    const { service, events, sessionId } = createService();
    const promise = service.request(sessionId, "approval", basePayload, baseTrigger);
    const requestEvent = events.at(0)?.event;
    if (requestEvent?.type !== "hitl.request") throw new Error("hitl request event missing");

    expect(service.respond(requestEvent.hitlId, approvePayload)).toBe(true);

    const response = await promise;
    expect(response).toEqual({
      hitlId: requestEvent.hitlId,
      kind: "approval",
      status: "resolved",
      response: approvePayload,
    });
    expect(service.has(requestEvent.hitlId)).toBe(false);
    expect(events.map((entry) => entry.event.type)).toEqual(["hitl.request", "hitl.resolved"]);
    expect(events.at(-1)?.event).toMatchObject({
      type: "hitl.resolved",
      sessionId,
      hitlId: requestEvent.hitlId,
      kind: "approval",
      status: "resolved",
      response: approvePayload,
    });
  });

  test("cancel resolves cancelled and removes pending request", async () => {
    const { service, events, sessionId } = createService();
    const promise = service.request(sessionId, "review", basePayload, baseTrigger);
    const requestEvent = events.at(0)?.event;
    if (requestEvent?.type !== "hitl.request") throw new Error("hitl request event missing");

    expect(service.cancel(requestEvent.hitlId, "Goal paused")).toBe(true);

    const response = await promise;
    expect(response).toEqual({
      hitlId: requestEvent.hitlId,
      kind: "review",
      status: "cancelled",
      reason: "Goal paused",
    });
    expect(service.has(requestEvent.hitlId)).toBe(false);
    expect(events.at(-1)?.event).toMatchObject({
      type: "hitl.resolved",
      sessionId,
      hitlId: requestEvent.hitlId,
      status: "cancelled",
      reason: "Goal paused",
    });
  });

  test("timeout resolves timeout and ignores later responses", async () => {
    const { service, events } = createService();
    const promise = service.request("session-timeout", "question", basePayload, {
      ...baseTrigger,
      timeoutMs: 1,
    });
    const requestEvent = events.at(0)?.event;
    if (requestEvent?.type !== "hitl.request") throw new Error("hitl request event missing");

    await new Promise((resolve) => setTimeout(resolve, 5));
    await flushMicrotasks();

    const response = await promise;
    expect(response).toEqual({
      hitlId: requestEvent.hitlId,
      kind: "question",
      status: "timeout",
      reason: "Timed out",
    });
    expect(service.has(requestEvent.hitlId)).toBe(false);
    expect(service.respond(requestEvent.hitlId, approvePayload)).toBe(false);
    expect(events.at(-1)?.event).toMatchObject({
      type: "hitl.resolved",
      hitlId: requestEvent.hitlId,
      status: "timeout",
    });
  });

  test("abort signal resolves cancelled", async () => {
    const { service, events } = createService();
    const abortController = new AbortController();
    const promise = service.request("session-abort", "question", basePayload, {
      ...baseTrigger,
      abortSignal: abortController.signal,
    });
    const requestEvent = events.at(0)?.event;
    if (requestEvent?.type !== "hitl.request") throw new Error("hitl request event missing");

    abortController.abort();
    await flushMicrotasks();

    const response = await promise;
    expect(response).toEqual({
      hitlId: requestEvent.hitlId,
      kind: "question",
      status: "cancelled",
      reason: "Aborted",
    });
    expect(service.has(requestEvent.hitlId)).toBe(false);
    expect(events.at(-1)?.event).toMatchObject({ status: "cancelled", reason: "Aborted" });
  });

  test("pre-aborted request emits request and resolved events without entering pending queue", async () => {
    const { service, events } = createService();
    const abortController = new AbortController();
    abortController.abort();

    const promise = service.request("session-pre-abort", "question", basePayload, {
      ...baseTrigger,
      abortSignal: abortController.signal,
    });

    const response = await promise;
    expect(response).toMatchObject({ status: "cancelled", reason: "Aborted" });
    expect(service.listPending()).toHaveLength(0);
    expect(events.map((entry) => entry.event.type)).toEqual(["hitl.request", "hitl.resolved"]);
  });

  test("shutdown resolves all pending requests as cancelled", async () => {
    const { service, events } = createService();
    const first = service.request("session-1", "approval", basePayload, baseTrigger);
    const second = service.request("session-2", "review", basePayload, {
      ...baseTrigger,
      goalId: "goal-2",
    });

    service.shutdown();

    const firstResponse = await first;
    const secondResponse = await second;
    expect(firstResponse).toMatchObject({ status: "cancelled", reason: "Shutdown" });
    expect(secondResponse).toMatchObject({ status: "cancelled", reason: "Shutdown" });
    expect(service.listPending()).toHaveLength(0);
    expect(events.filter((entry) => entry.event.type === "hitl.resolved")).toHaveLength(2);
  });

  test("listPending filters by project, goal, and loop", () => {
    const { service, events } = createService();
    service.request("session-1", "approval", basePayload, baseTrigger);
    service.request("session-2", "review", basePayload, {
      ...baseTrigger,
      projectSlug: "other-project",
      goalId: "goal-2",
      loopId: undefined,
    });

    expect(service.listPending()).toHaveLength(2);
    expect(service.listPending("archcode")).toHaveLength(1);
    expect(service.listPending("archcode", "goal-1")).toHaveLength(1);
    expect(service.listPending("archcode", "goal-2")).toHaveLength(0);
    expect(service.listPending(undefined, undefined, "loop-1")).toHaveLength(1);

    for (const event of events) {
      if (event.event.type === "hitl.request") service.cancel(event.event.hitlId, "test cleanup");
    }
  });

  test("respond and cancel return false for missing requests", () => {
    const { service } = createService();

    expect(service.respond("missing", approvePayload)).toBe(false);
    expect(service.cancel("missing")).toBe(false);
  });
});
