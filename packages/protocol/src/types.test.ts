import { describe, expect, test } from "bun:test";
import { HITL_RECENT_TERMINAL_LIMIT, hitlIdentityKey } from "./types";
import { createEmptySessionStats } from "./usage";
import type {
  CompressionBlockCommittedEvent,
  CompressionBlockPart,
  CompressionBlockSnapshot,
  CompressionRefMapUpdatedEvent,
  CompressionStateSnapshot,
  GoalState,
  GoalStatus,
  HitlFile,
  HitlProjection,
  HitlRecord,
  HitlResponse,
  HitlStreamEvent,
  GoalStreamEvent,
  GlobalSSEEvent,
  GlobalSSEResourceChangedEvent,
  GlobalSSEHeartbeatEvent,
  GlobalSSELaggedEvent,
  GlobalSSEResetEvent,
  GlobalSSESessionRuntimeChangedEvent,
  GlobalSSESessionRuntimeSnapshotEvent,
  GlobalSSEShutdownEvent,
  GlobalSessionEventEnvelope,
  StreamEvent,
  TextDeltaEvent,
  ToolAttemptEvent,
  SessionEventPayload,
  Automation,
  AutomationInvocation,
  AutomationStatus,
  AutomationTrigger,
  AutomationAction,
  SessionSummary,
  Session,
} from "./types";

function serializeRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function compositeIdentity(event: GlobalSessionEventEnvelope): string {
  return `${event.slug}:${event.sessionId}:${event.eventId}`;
}

describe("global SSE wire protocol types", () => {
  test("uses strict resource.changed variants for Goals and Automations", () => {
    const events: GlobalSSEResourceChangedEvent[] = [{
      type: "resource.changed",
      projectSlug: "project-a",
      resourceType: "goal",
      resourceId: "goal-1",
      reason: "title_generated",
      createdAt: 1,
    }, {
      type: "resource.changed",
      projectSlug: "project-a",
      resourceType: "automation",
      resourceId: "automation-1",
      reason: "invocation_changed",
      createdAt: 2,
    }];

    expect(serializeRoundTrip(events)).toEqual(events);
  });

  test("round-trips a global session event envelope", () => {
    const event: GlobalSessionEventEnvelope<TextDeltaEvent> = {
      type: "event",
      slug: "proj-a",
      sessionId: "s1",
      eventId: 42,
      createdAt: 1,
      kind: "text-delta",
      payload: { type: "text-delta", text: "hello" },
      agentName: "engineer",
    };

    const parsed = serializeRoundTrip(event);

    expect(parsed).toEqual(event);
    expect(parsed.type).toBe("event");
    expect(parsed.slug).toBe("proj-a");
    expect(parsed.sessionId).toBe("s1");
    expect(parsed.eventId).toBe(42);
    expect(parsed.createdAt).toBe(1);
    expect(parsed.kind).toBe("text-delta");
    expect(parsed.payload).toEqual({ type: "text-delta", text: "hello" });
    expect(parsed.agentName).toBe("engineer");
  });

  test("distinguishes matching event IDs by composite identity", () => {
    const first: GlobalSessionEventEnvelope<TextDeltaEvent> = {
      type: "event",
      slug: "proj-a",
      sessionId: "s1",
      eventId: 42,
      createdAt: 1,
      kind: "text-delta",
      payload: { type: "text-delta", text: "hello" },
      agentName: "engineer",
    };
    const second: GlobalSessionEventEnvelope<TextDeltaEvent> = {
      ...first,
      slug: "proj-b",
      sessionId: "s2",
      payload: { type: "text-delta", text: "world" },
    };

    expect(first.eventId).toBe(second.eventId);
    expect(compositeIdentity(first)).toBe("proj-a:s1:42");
    expect(compositeIdentity(second)).toBe("proj-b:s2:42");
    expect(compositeIdentity(first)).not.toBe(compositeIdentity(second));
  });

  test("serializes heartbeat, reset, lagged, and shutdown events", () => {
    const heartbeat: GlobalSSEHeartbeatEvent = { type: "heartbeat", createdAt: 1 };
    const reset: GlobalSSEResetEvent = {
      type: "reset",
      slug: "proj-a",
      sessionId: "s1",
      reason: "stale_cursor",
    };
    const lagged: GlobalSSELaggedEvent = {
      type: "lagged",
      dropped: 3,
      reason: "client_backpressure",
    };
    const shutdown: GlobalSSEShutdownEvent = { type: "shutdown", reason: "server stopping" };

    expect(serializeRoundTrip(heartbeat)).toEqual(heartbeat);
    expect(serializeRoundTrip(reset)).toEqual(reset);
    expect(serializeRoundTrip(lagged)).toEqual(lagged);
    expect(serializeRoundTrip(shutdown)).toEqual(shutdown);
  });

  test("round-trips Session Family runtime snapshot and change events", () => {
    const snapshot: GlobalSSESessionRuntimeSnapshotEvent = {
      type: "session.runtime.snapshot",
      projectSlugs: ["proj-a", "proj-b"],
      families: [{ projectSlug: "proj-a", rootSessionId: "root-1", activity: "running" }],
      createdAt: 10,
    };
    const changed: GlobalSSESessionRuntimeChangedEvent = {
      type: "session.runtime_changed",
      projectSlug: "proj-a",
      rootSessionId: "root-1",
      activity: "idle",
      createdAt: 11,
    };

    expect(serializeRoundTrip(snapshot)).toEqual(snapshot);
    expect(serializeRoundTrip(changed)).toEqual(changed);
  });

  test("accepts all global SSE event subtypes in the union", () => {
    const events: GlobalSSEEvent[] = [
      {
        type: "event",
        slug: "proj-a",
        sessionId: "s1",
        eventId: 42,
        createdAt: 1,
        kind: "text-delta",
        payload: { type: "text-delta", text: "hello" },
        agentName: "engineer",
      },
      { type: "heartbeat", createdAt: 2 },
      { type: "reset", slug: "proj-a", sessionId: "s1", reason: "store_unavailable" },
      { type: "lagged", dropped: 5, reason: "client_backpressure" },
      { type: "shutdown" },
      {
        type: "session.runtime.snapshot",
        projectSlugs: ["proj-a"],
        families: [{ projectSlug: "proj-a", rootSessionId: "s1", activity: "stopping" }],
        createdAt: 3,
      },
      {
        type: "session.runtime_changed",
        projectSlug: "proj-a",
        rootSessionId: "s1",
        activity: "idle",
        createdAt: 4,
      },
      {
        type: "hitl.snapshot",
        projectSlugs: ["proj-a"],
        projections: [],
        createdAt: 3,
      },
      {
        type: "hitl.event",
        projectSlug: "proj-a",
        owner: { projectSlug: "proj-a", ownerType: "session", ownerId: "s1" },
        hitlId: "hitl-1",
        createdAt: 4,
        payload: { type: "hitl.request", status: "pending" },
        projection: {} as HitlProjection,
      },
    ];

    expect(events.map((event) => event.type)).toEqual([
      "event",
      "heartbeat",
      "reset",
      "lagged",
      "shutdown",
      "session.runtime.snapshot",
      "session.runtime_changed",
      "hitl.snapshot",
      "hitl.event",
    ]);
  });

  test("tool-attempt events are serializable and replay-safe", () => {
    const event: ToolAttemptEvent = {
      type: "tool-attempt",
      toolCallId: "call-1",
      toolName: "file_write",
      attemptId: "attempt-1",
      timestamp: 123,
      destructive: true,
    };

    expect(serializeRoundTrip(event)).toEqual(event);
  });
});

describe("compression protocol types", () => {
  test("compression events and state snapshots serialize", () => {
    const block: CompressionBlockSnapshot = {
      id: "block-1",
      ref: "b1",
      status: "active",
      strategy: "dynamic-range",
      trigger: "model_tool_call",
      range: {
        startMessageId: "msg-a",
        endMessageId: "msg-b",
        startRef: "m0001",
        endRef: "m0002",
        startIndex: 0,
        endIndex: 1,
      },
      summary: "summary",
      childBlockRefs: [],
      protectedRefs: ["m0002"],
      tokenEstimate: { originalTokens: 100, summaryTokens: 20, savedTokens: 80, estimatedAt: 1 },
      createdAt: 1,
      updatedAt: 1,
    };
    const state: CompressionStateSnapshot = {
      version: 1,
      refMap: {
        messageRefsById: { "msg-a": "m0001", "msg-b": "m0002" },
        messageIdsByRef: { m0001: "msg-a", m0002: "msg-b" },
        blockRefsById: { "block-1": "b1" },
        blockIdsByRef: { b1: "block-1" },
        nextMessageIndex: 3,
        nextBlockIndex: 2,
      },
      blocksByRef: { b1: block },
      activeBlockRefs: ["b1"],
      inactiveBlockRefs: [],
      supersededBlockRefs: [],
      failures: [],
      updatedAt: 1,
    };
    const event: CompressionBlockCommittedEvent = {
      type: "compression.block_committed",
      block,
      state,
    };

    expect(serializeRoundTrip(event)).toEqual(event);
    expect(event.state?.blocksByRef.b1?.strategy).toBe("dynamic-range");
  });

  test("compression ref-map events and parts are discriminated", () => {
    const event: CompressionRefMapUpdatedEvent = {
      type: "compression.ref_map_updated",
      refMap: {
        messageRefsById: { "msg-a": "m0001" },
        messageIdsByRef: { m0001: "msg-a" },
        blockRefsById: {},
        blockIdsByRef: {},
        nextMessageIndex: 2,
        nextBlockIndex: 1,
      },
      updatedAt: 10,
    };
    const part: CompressionBlockPart = {
      type: "compression-block",
      id: "part-1",
      blockRef: "b1",
      status: "active",
      strategy: "dynamic-range",
      trigger: "soft_nudge_response",
      summary: "summary",
      startRef: "m0001",
      endRef: "m0002",
      childBlockRefs: [],
      committedAt: 10,
    };

    expect(serializeRoundTrip(event)).toEqual(event);
    expect(serializeRoundTrip(part)).toEqual(part);
  });
});

describe("Goal types", () => {
  test("GoalStatus is the simplified durable execution envelope", () => {
    const statuses: GoalStatus[] = [
      "running",
      "reviewing",
      "done",
      "not_done",
      "failed",
      "cancelled",
    ];

    expect(statuses).toEqual([
      "running",
      "reviewing",
      "done",
      "not_done",
      "failed",
      "cancelled",
    ]);
  });

  test("GoalState serializes the natural-language contract with review evidence", () => {
    const state: GoalState = {
      version: 4,
      id: "goal-1",
      projectId: "my-project",
      createdFromSessionId: "session-source",
      title: "Implement auth",
      objective: "Build the requested authentication flow.",
      acceptanceCriteria: "Users can sign in and invalid credentials are rejected.",
      useWorktree: false,
      status: "done",
      attempt: 2,
      reviewGeneration: 1,
      budget: {
        status: "ok",
        usedTokens: 1200,
        maxTokens: 5000,
        updatedAt: "2026-01-01T00:04:00.000Z",
      },
      pendingHitlIds: [],
      approvalRefs: ["hitl-approval-1"],
      appliedHitlIds: ["hitl-approval-1"],
      mainSessionId: "session-main",
      childSessionIds: ["session-build", "session-review"],
      review: {
        reviewGeneration: 1,
        verdict: "DONE",
        summary: "Reviewer confirmed the acceptance criteria are satisfied.",
        evidenceRefs: [
          {
            kind: "test_output",
            ref: "test-output-1",
            summary: "Targeted protocol tests passed and cover the new contract.",
            sessionId: "session-review",
            toolCallId: "tool-call-1",
            createdAt: "2026-01-01T00:03:00.000Z",
          },
          {
            kind: "diff",
            ref: "diff-1",
            summary: "The diff shows old Goal DSL types were removed.",
            path: "packages/protocol/src/types.ts",
          },
        ],
        reviewerSessionId: "session-review",
        decidedAt: "2026-01-01T00:05:00.000Z",
      },
      finalSummary: "Authentication flow completed and reviewed.",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:05:00.000Z",
      startedAt: "2026-01-01T00:01:00.000Z",
      completedAt: "2026-01-01T00:05:00.000Z",
    };

    const parsed = serializeRoundTrip(state);

    expect(parsed).toEqual(state);
    expect(parsed.objective).toContain("authentication");
    expect(parsed.acceptanceCriteria).toContain("invalid credentials");
    expect(parsed.review?.verdict).toBe("DONE");
    expect(parsed.review?.evidenceRefs[0]?.summary).toContain("Targeted protocol tests");
  });

  test("Goal blockers and NOT_DONE receipts round-trip", () => {
    const state: GoalState = {
      version: 4,
      id: "goal-2",
      projectId: "my-project",
      createdFromSessionId: "session-source",
      title: "Fix bug",
      objective: "Resolve the reported bug.",
      acceptanceCriteria: "The bug no longer reproduces.",
      useWorktree: false,
      status: "running",
      blocker: {
        kind: "question",
        summary: "Need user clarification on expected behavior.",
        hitlId: "hitl-1",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
      attempt: 1,
      reviewGeneration: 1,
      pendingHitlIds: ["hitl-1"],
      approvalRefs: ["hitl-1"],
      appliedHitlIds: [],
      mainSessionId: "session-main",
      childSessionIds: [],
      startedAt: "2026-06-01T00:00:00.000Z",
      review: {
        reviewGeneration: 1,
        verdict: "NOT_DONE",
        summary: "Cannot complete without the requested clarification.",
        evidenceRefs: [],
        unresolvedItems: ["Clarify expected behavior"],
        reviewerSessionId: "session-review",
        decidedAt: "2026-06-01T00:01:00.000Z",
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:01:00.000Z",
      lastError: {
        name: "QuestionBlockedError",
        message: "Awaiting user clarification",
        at: "2026-06-01T00:01:00.000Z",
      },
    };

    const parsed = serializeRoundTrip(state);

    expect(parsed.status).toBe("running");
    expect(parsed.blocker?.kind).toBe("question");
    expect(parsed.review?.verdict).toBe("NOT_DONE");
    expect(parsed.review?.unresolvedItems).toEqual(["Clarify expected behavior"]);
    expect(parsed.lastError?.name).toBe("QuestionBlockedError");
  });
});

describe("HITL types", () => {
  test("uses a bounded recent-terminal retention limit", () => {
    expect(HITL_RECENT_TERMINAL_LIMIT).toBe(20);
  });

  test("keys HITL identity by owner and owner-local id", () => {
    const first = hitlIdentityKey({
      owner: { projectSlug: "project", ownerType: "session", ownerId: "session-a" },
      hitlId: "shared-id",
    });
    const second = hitlIdentityKey({
      owner: { projectSlug: "project", ownerType: "session", ownerId: "session-b" },
      hitlId: "shared-id",
    });

    expect(first).not.toBe(second);
  });

  test("serializes HitlResponse question variant", () => {
    const response: HitlResponse = {
      type: "question_answer",
      answers: ["Yes"],
      comment: "Looks good",
    };

    const parsed = serializeRoundTrip(response);
    expect(parsed).toEqual(response);
    expect(parsed.type).toBe("question_answer");
  });

  test("serializes HitlResponse approval variant", () => {
    const response: HitlResponse = {
      type: "permission_decision",
      decision: "approve_once",
    };

    const parsed = serializeRoundTrip(response);
    expect(parsed).toEqual(response);
    expect(parsed.decision).toBe("approve_once");
  });

  test("serializes HitlResponse review variant", () => {
    const response: HitlResponse = {
      type: "review_outcome",
      outcome: "NOT_DONE",
      comment: "Needs more tests",
      receipt: {
        reviewGeneration: 1,
        verdict: "NOT_DONE",
        summary: "Needs more tests",
        evidenceRefs: [],
        reviewerSessionId: "reviewer-session",
        decidedAt: "2026-07-14T00:00:00.000Z",
      },
    };

    const parsed = serializeRoundTrip(response);
    expect(parsed).toEqual(response);
    expect(parsed.outcome).toBe("NOT_DONE");
  });

  test("serializes owner-local HitlRecord with display-only payload", () => {
    const record: HitlRecord = {
      hitlId: "hitl-1",
      owner: { projectSlug: "my-project", ownerType: "goal", ownerId: "goal-1" },
      blockingKey: "goal-1:before-complete",
      source: {
        type: "goal_approval",
        goalId: "goal-1",
        approvalPoint: "before_complete",
      },
      status: "pending",
      displayPayload: {
        title: "Approve completion",
        summary: "Tool input redacted for dashboard display.",
        fields: [{ label: "Goal", value: "goal-1" }],
        redacted: true,
      },
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    };

    const parsed = serializeRoundTrip(record);
    const serialized = JSON.stringify(parsed);

    expect(parsed).toEqual(record);
    expect(parsed.hitlId).toBe("hitl-1");
    expect(parsed.status).toBe("pending");
    expect(parsed.displayPayload.redacted).toBe(true);
    expect(serialized).not.toContain("workspaceRoot");
    expect(serialized).not.toContain("rawToolInput");
    expect(serialized).not.toContain("resumeCheckpoint");
  });

  test("serializes HitlFile owner partitions", () => {
    const pending: HitlRecord = {
      hitlId: "hitl-1",
      owner: { projectSlug: "my-project", ownerType: "session", ownerId: "session-1" },
      blockingKey: "session:session-1:ask:hitl-1",
      source: { type: "ask_user", sessionId: "session-1" },
      status: "pending",
      displayPayload: { title: "Choose", redacted: true },
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    };
    const file: HitlFile = {
      version: 1,
      owner: pending.owner,
      pending: [pending],
      recentTerminal: [{ ...pending, hitlId: "hitl-0", status: "resolved", response: { type: "question_answer", answers: ["A"] }, resolvedAt: "2026-07-03T00:01:00.000Z" }],
      updatedAt: "2026-07-03T00:01:00.000Z",
    };

    expect(serializeRoundTrip(file)).toEqual(file);
  });

  test("HitlProjection remains display-safe", () => {
    const projection: HitlProjection = {
      hitlId: "hitl-1",
      project: { slug: "my-project", name: "My Project" },
      owner: { projectSlug: "my-project", ownerType: "goal", ownerId: "goal-1" },
      ancestry: { rootSessionId: "session-root", goalId: "goal-1", projectionPath: ["goal", "goal-1"] },
      source: { type: "goal_budget", goalId: "goal-1" },
      status: "pending",
      displayPayload: { title: "Goal blocked", summary: "Budget warning", redacted: true },
      allowedActions: ["approve", "deny", "cancel"],
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    };

    const serialized = JSON.stringify(serializeRoundTrip(projection));

    expect(serialized).toContain("Goal blocked");
    expect(serialized).not.toContain("workspaceRoot");
    expect(serialized).not.toContain("rawToolInput");
    expect(serialized).not.toContain("rawCheckpoint");
  });

  test("serializes resolved HitlRecord with response", () => {
    const request: HitlRecord = {
      hitlId: "hitl-2",
      owner: { projectSlug: "my-project", ownerType: "session", ownerId: "session-1" },
      blockingKey: "session:session-1:ask:hitl-2",
      source: { type: "ask_user", sessionId: "session-1" },
      status: "resolved",
      displayPayload: { title: "Which approach?", redacted: true },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:01:00.000Z",
      resolvedAt: "2026-06-01T00:01:00.000Z",
      response: { type: "question_answer", answers: ["A"] },
    };

    const parsed = serializeRoundTrip(request);
    expect(parsed).toEqual(request);
    expect(parsed.status).toBe("resolved");
    expect(parsed.response).toEqual({ type: "question_answer", answers: ["A"] });
  });
});

describe("Goal/HITL stream events", () => {
  function makeGoalState(overrides: Partial<GoalState> = {}): GoalState {
    return {
      version: 4,
      id: "goal-1",
      projectId: "p",
      createdFromSessionId: "session-source",
      title: "Implement feature",
      objective: "Implement the requested feature.",
      acceptanceCriteria: "Feature behavior satisfies the request.",
      useWorktree: false,
      status: "running",
      attempt: 1,
      reviewGeneration: 0,
      mainSessionId: "session-main",
      pendingHitlIds: [],
      approvalRefs: [],
      appliedHitlIds: [],
      childSessionIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  test("GoalStreamEvent only carries state changes", () => {
    const stateChange: GoalStreamEvent = {
      type: "goal.state_change",
      goalId: "goal-1",
      status: "running",
      state: makeGoalState(),
    };

    expect(serializeRoundTrip(stateChange)).toEqual(stateChange);
  });

  test("StreamEvent and SessionEventPayload unions accept Goal state change and HITL events", () => {
    const goalEvent: GoalStreamEvent = {
      type: "goal.state_change",
      goalId: "g-1",
      status: "reviewing",
      state: makeGoalState({ id: "g-1", status: "reviewing" }),
    };
    const events: StreamEvent[] = [
      goalEvent,
      { type: "hitl.request", request: {} as HitlRecord },
      { type: "hitl.updated", record: {} as HitlRecord },
      { type: "hitl.resolved", hitlId: "h-1", status: "resolved" },
    ];
    const payloads: SessionEventPayload[] = events;

    expect(events).toHaveLength(4);
    expect(payloads.map((p) => p.type)).toEqual([
      "goal.state_change",
      "hitl.request",
      "hitl.updated",
      "hitl.resolved",
    ]);
  });

  test("GoalStreamEvent discriminates simplified status values", () => {
    const reviewingEvent: GoalStreamEvent = {
      type: "goal.state_change",
      goalId: "g-1",
      status: "reviewing",
      state: makeGoalState({ id: "g-1", status: "reviewing" }),
    };
    const notDoneEvent: GoalStreamEvent = {
      type: "goal.state_change",
      goalId: "g-2",
      status: "not_done",
      state: makeGoalState({ id: "g-2", status: "not_done" }),
    };

    expect(reviewingEvent.status).toBe("reviewing");
    expect(notDoneEvent.status).toBe("not_done");
  });

  test("HitlStreamEvent types are serializable", () => {
    const hitlRequestEvent: HitlStreamEvent = {
      type: "hitl.request",
      request: {
        hitlId: "hitl-1",
        owner: { projectSlug: "project-a", ownerType: "session", ownerId: "session-1" },
        blockingKey: "session:session-1:ask:hitl-1",
        source: { type: "ask_user", sessionId: "session-1" },
        status: "pending",
        displayPayload: { title: "Proceed?", redacted: true },
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      },
    };

    const hitlResolvedEvent: HitlStreamEvent = {
      type: "hitl.resolved",
      hitlId: "hitl-1",
      status: "resolved",
      response: { type: "question_answer", answers: ["Yes"] },
    };

    const hitlUpdatedEvent: HitlStreamEvent = {
      type: "hitl.updated",
      record: {
        ...hitlRequestEvent.request,
        status: "answered",
        response: { type: "question_answer", answers: ["continue"] },
        delivery: {
          claimId: "claim-1",
          claimedAt: "2026-06-01T00:01:00.000Z",
          intent: "respond",
          attempt: 1,
        },
      },
    };

    expect(serializeRoundTrip(hitlRequestEvent)).toEqual(hitlRequestEvent);
    expect(serializeRoundTrip(hitlUpdatedEvent)).toEqual(hitlUpdatedEvent);
    expect(serializeRoundTrip(hitlResolvedEvent)).toEqual(hitlResolvedEvent);
  });
});

describe("Automation types", () => {
  function serializeRoundTrip<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  test("models exactly one time trigger and one Session action", () => {
    const statuses: AutomationStatus[] = ["active", "paused", "disabled"];
    const trigger: AutomationTrigger = { kind: "cron", expression: "0 9 * * 1", timezone: "Asia/Shanghai" };
    const action: AutomationAction = { kind: "start_session", message: "/skill use review", location: "worktree" };
    const automation: Automation = {
      id: "automation-1",
      projectId: "project-1",
      createdFromSessionId: "session-source",
      name: "Weekly review",
      status: "active",
      trigger,
      action,
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
    };
    const invocation: AutomationInvocation = {
      id: "invocation-1",
      automationId: automation.id,
      dueAt: "2026-07-14T01:00:00.000Z",
      status: "pending",
      executionId: "execution-1",
      createdAt: "2026-07-14T01:00:00.000Z",
    };

    expect(statuses).toEqual(["active", "paused", "disabled"]);
    expect(serializeRoundTrip(automation)).toEqual(automation);
    expect(serializeRoundTrip(invocation)).toEqual(invocation);
  });
});
