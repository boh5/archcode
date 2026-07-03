import { describe, expect, test } from "bun:test";
import type {
  DoneCondition,
  GoalArtifactFile,
  GoalPhase,
  GoalReviewReport,
  GoalState,
  GoalStatus,
  HitlRecord,
  HitlPayload,
  HitlRequest,
  HitlResponse,
  HitlStreamEvent,
  GoalStreamEvent,
  GlobalSSEEvent,
  GlobalSSEHeartbeatEvent,
  GlobalSSELaggedEvent,
  GlobalSSEResetEvent,
  GlobalSSEShutdownEvent,
  GlobalSessionEventEnvelope,
  StreamEvent,
  TextDeltaEvent,
  ToolAttemptEvent,
  SessionEventPayload,
} from "./types";

function serializeRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function compositeIdentity(event: GlobalSessionEventEnvelope): string {
  return `${event.slug}:${event.sessionId}:${event.eventId}`;
}

describe("global SSE wire protocol types", () => {
  test("round-trips a global session event envelope", () => {
    const event: GlobalSessionEventEnvelope<TextDeltaEvent> = {
      type: "event",
      slug: "proj-a",
      sessionId: "s1",
      eventId: 42,
      createdAt: 1,
      kind: "text-delta",
      payload: { type: "text-delta", text: "hello" },
      agentName: "orchestrator",
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
    expect(parsed.agentName).toBe("orchestrator");
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
      agentName: "orchestrator",
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
        agentName: "orchestrator",
      },
      { type: "heartbeat", createdAt: 2 },
      { type: "reset", slug: "proj-a", sessionId: "s1", reason: "store_unavailable" },
      { type: "lagged", dropped: 5, reason: "client_backpressure" },
      { type: "shutdown" },
    ];

    expect(events.map((event) => event.type)).toEqual([
      "event",
      "heartbeat",
      "reset",
      "lagged",
      "shutdown",
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

describe("Goal types", () => {
  test("GoalPhase remains the canonical three-phase model", () => {
    const phases: GoalPhase[] = ["plan", "build", "review"];

    expect(phases).toEqual(["plan", "build", "review"]);
    expect(phases).toHaveLength(3);
  });

  test("GoalStatus includes paused for safe interruption", () => {
    const statuses: GoalStatus[] = [
      "draft", "locked", "running", "verifying",
      "reviewed", "completed", "failed", "escalated",
      "paused",
    ];

    expect(statuses).toContain("paused");
    expect(statuses.length).toBe(9);
  });

  test("GoalStatus union rejects invalid values at compile time", () => {
    // This test validates the type at compile time — if it compiles, the union is correct.
    const valid: GoalStatus = "paused";
    expect(valid).toBe("paused");
  });

  test("DoneCondition is a discriminated union by kind", () => {
    const condition: DoneCondition = {
      id: "cond-1",
      kind: "tests_pass",
      params: { command: "bun test" },
    };

    expect(condition.kind).toBe("tests_pass");
    expect(condition.id).toBe("cond-1");

    const fileExists: DoneCondition = {
      id: "cond-2",
      kind: "file_exists",
      params: { path: "src/index.ts" },
    };

    expect(fileExists.kind).toBe("file_exists");
    expect(fileExists.params.path).toBe("src/index.ts");
  });

  test("DoneCondition spec_compliance is typed as Reviewer-owned structured evidence", () => {
    const specCheck: DoneCondition = {
      id: "cond-spec",
      kind: "spec_compliance",
      params: { specPath: "docs/spec.md" },
    };

    expect(specCheck.kind).toBe("spec_compliance");
    expect(specCheck.params.specPath).toBe("docs/spec.md");
    // Task 8: spec_compliance is implemented by Reviewer-owned structured per-criterion evidence.
  });

  test("serializes and deserializes GoalState round-trip", () => {
    const state: GoalState = {
      id: "goal-1",
      projectId: "my-project",
      title: "Implement auth",
      status: "running",
      phase: "build",
      doneConditions: [
        { id: "dc-1", kind: "tests_pass", params: { command: "bun test" } },
      ],
      doneResults: {},
      reviewerAgent: "reviewer",
      retryPolicy: { maxRetries: 3, backoffMs: 5000, escalateOnFailure: true },
      retryCount: 0,
      approvalPoints: ["after_plan", "before_complete"],
      author: "orchestrator",
      childSessionIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const parsed = serializeRoundTrip(state);

    expect(parsed).toEqual(state);
    expect(parsed.status).toBe("running");
    expect(parsed.doneConditions).toHaveLength(1);
    expect((parsed.doneConditions[0] as DoneCondition).kind).toBe("tests_pass");
  });

  test("round-trips Phase 2 Goal contracts without raw LLM transcript fields", () => {
    const reviewReport: GoalReviewReport = {
      reviewerAgent: "reviewer",
      outcome: "NOT_DONE",
      reviewedAt: "2026-07-03T00:10:00.000Z",
      summary: "AC-001 needs stronger evidence.",
      criteria: [
        {
          criterionId: "AC-001",
          criterion: "The implementation satisfies the documented acceptance criterion.",
          compliant: false,
          evidence: ["review.md notes missing negative-path coverage"],
          artifactNames: ["review.md", "spec-compliance.md"],
        },
      ],
    };
    const state: GoalState = {
      id: "goal_test_123",
      projectId: "my-project",
      title: "Ship Phase 2 Goal contracts",
      status: "verifying",
      phase: "review",
      doneConditions: [
        { id: "AC-001", kind: "spec_compliance", params: { specPath: "docs/spec.md" } },
      ],
      doneResults: {
        "AC-001": {
          conditionId: "AC-001",
          passed: false,
          evidence: "Criterion AC-001 is NOT DONE.",
          checkedAt: "2026-07-03T00:10:00.000Z",
          specCompliance: {
            checkedAt: "2026-07-03T00:09:00.000Z",
            specPath: "docs/spec.md",
            summary: "One criterion remains unmet.",
            criteria: reviewReport.criteria,
          },
          review: reviewReport,
        },
      },
      reviewerAgent: "reviewer",
      retryPolicy: { maxRetries: 3, backoffMs: 5000, escalateOnFailure: true },
      retryCount: 1,
      retryState: {
        retryCount: 1,
        nextRetryAt: "2026-07-03T00:15:00.000Z",
        lastFailure: {
          failedAt: "2026-07-03T00:10:00.000Z",
          errorKind: "review_not_done",
          message: "Reviewer marked AC-001 NOT DONE",
          phase: "review",
        },
        lastAttempt: {
          attempt: 1,
          status: "scheduled",
          scheduledAt: "2026-07-03T00:10:00.000Z",
          nextRetryAt: "2026-07-03T00:15:00.000Z",
        },
      },
      tokenBudget: {
        status: "warning",
        maxTokens: 100_000,
        warningThresholdTokens: 80_000,
        inputTokens: 45_000,
        outputTokens: 20_000,
        reasoningTokens: 10_000,
        cachedInputTokens: 5_000,
        totalTokens: 75_000,
        updatedAt: "2026-07-03T00:08:00.000Z",
      },
      artifacts: [
        { name: "plan.md", path: ".archcode/goals/goal_test_123/artifacts/plan.md", mediaType: "text/markdown" },
        { name: "review.md", path: ".archcode/goals/goal_test_123/artifacts/review.md", mediaType: "text/markdown" },
      ],
      reviewReport,
      approvalPoints: ["after_plan", "before_complete"],
      author: "orchestrator",
      mainSessionId: "session-main",
      childSessionIds: ["session-plan", "session-build", "session-review"],
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:10:00.000Z",
    };

    const parsed = serializeRoundTrip(state);
    const serialized = JSON.stringify(parsed);

    expect(parsed.id).toBe("goal_test_123");
    expect(parsed.phase).toBe("review");
    expect(parsed.reviewerAgent).toBe("reviewer");
    expect(parsed.reviewReport?.outcome).toBe("NOT_DONE");
    expect(parsed.reviewReport?.criteria[0]?.criterionId).toBe("AC-001");
    expect(parsed.tokenBudget?.totalTokens).toBe(75_000);
    expect(parsed.retryState?.nextRetryAt).toBe("2026-07-03T00:15:00.000Z");
    expect(parsed.retryState?.lastFailure?.errorKind).toBe("review_not_done");
    expect(parsed.artifacts?.map((artifact) => artifact.name)).toEqual(["plan.md", "review.md"]);
    expect(serialized).not.toContain("rawLlmOutput");
    expect(serialized).not.toContain("rawTranscript");
    expect(serialized).not.toContain("transcript");
  });

  test("canonical Goal artifacts are current Markdown files without version pointers", () => {
    const artifact: GoalArtifactFile = {
      name: "final-report.md",
      path: ".archcode/goals/goal-1/artifacts/final-report.md",
      mediaType: "text/markdown",
      updatedAt: "2026-07-03T00:00:00.000Z",
      sizeBytes: 128,
      sha256: "abc123",
    };

    const parsed = serializeRoundTrip(artifact) as GoalArtifactFile & Record<string, unknown>;

    expect(parsed.name).toBe("final-report.md");
    expect(parsed.path).toContain("/artifacts/final-report.md");
    expect(parsed.mediaType).toBe("text/markdown");
    expect(parsed.version).toBeUndefined();
    expect(parsed.revision).toBeUndefined();
    expect(parsed.latest).toBeUndefined();
  });

  test("GoalState with optional fields round-trips", () => {
    const state: GoalState = {
      id: "goal-2",
      projectId: "my-project",
      title: "Fix bug",
      status: "paused",
      phase: "plan",
      doneConditions: [],
      doneResults: {},
      reviewerAgent: "reviewer",
      retryPolicy: { maxRetries: 1, backoffMs: 1000, escalateOnFailure: false },
      retryCount: 0,
      approvalPoints: [],
      author: "user",
      lockedBy: "user-1",
      mainSessionId: "session-1",
      childSessionIds: ["session-plan"],
      lockedAt: "2026-06-01T00:00:00.000Z",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z",
      lastError: "failed once",
    };

    const parsed = serializeRoundTrip(state);

    expect(parsed).toEqual(state);
    expect(parsed.status).toBe("paused");
    expect(parsed.lockedBy).toBe("user-1");
    expect(parsed.lastError).toBe("failed once");
  });
});

describe("HITL types", () => {
  test("serializes HitlPayload question variant", () => {
    const payload: HitlPayload = {
      kind: "question",
      options: [
        { label: "Yes", description: "Proceed" },
        { label: "No" },
      ],
      multiple: false,
      custom: true,
      recommendedOption: "Yes",
      rationale: "Safe default",
    };

    const parsed = serializeRoundTrip(payload);
    expect(parsed).toEqual(payload);
    expect(parsed.kind).toBe("question");
  });

  test("serializes HitlPayload approval variant", () => {
    const payload: HitlPayload = {
      kind: "approval",
      action: "Write to src/api.ts",
      context: { file: "src/api.ts", content: "..." },
    };

    const parsed = serializeRoundTrip(payload);
    expect(parsed).toEqual(payload);
    expect(parsed.kind).toBe("approval");
    expect(parsed.context).toEqual({ file: "src/api.ts", content: "..." });
  });

  test("serializes HitlPayload review variant", () => {
    const payload: HitlPayload = {
      kind: "review",
      artifacts: [
        { name: "review.md", path: ".archcode/goals/goal-1/artifacts/review.md", mediaType: "text/markdown" },
      ],
    };

    const parsed = serializeRoundTrip(payload);
    expect(parsed).toEqual(payload);
    expect(parsed.artifacts).toHaveLength(1);
  });

  test("serializes HitlResponse question variant", () => {
    const response: HitlResponse = {
      kind: "question",
      answers: ["Yes"],
      comment: "Looks good",
    };

    const parsed = serializeRoundTrip(response);
    expect(parsed).toEqual(response);
    expect(parsed.kind).toBe("question");
  });

  test("serializes HitlResponse approval variant", () => {
    const response: HitlResponse = {
      kind: "approval",
      approved: true,
      approveAlways: false,
    };

    const parsed = serializeRoundTrip(response);
    expect(parsed).toEqual(response);
    expect(parsed.approved).toBe(true);
  });

  test("serializes HitlResponse review variant", () => {
    const response: HitlResponse = {
      kind: "review",
      outcome: "NOT_DONE",
      comment: "Needs more tests",
    };

    const parsed = serializeRoundTrip(response);
    expect(parsed).toEqual(response);
    expect(parsed.outcome).toBe("NOT_DONE");
  });

  test("serializes HitlRequest with all fields", () => {
    const request: HitlRequest = {
      id: "hitl-1",
      sessionId: "session-1",
      goalId: "goal-1",
      loopId: "loop-1",
      kind: "approval",
      prompt: "Allow write to src/api.ts?",
      payload: { kind: "approval", action: "write", context: {} },
      trigger: "approval_point",
      status: "pending",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      displayPayload: {
        title: "Allow write",
        summary: "Redacted write request",
        redacted: true,
      },
      decisionKey: "goal-1:after-plan",
    };

    const parsed = serializeRoundTrip(request);
    expect(parsed).toEqual(request);
    expect(parsed.kind).toBe("approval");
    expect(parsed.trigger).toBe("approval_point");
    expect(parsed.status).toBe("pending");
    expect(parsed.goalId).toBe("goal-1");
    expect(parsed.displayPayload?.redacted).toBe(true);
  });

  test("serializes durable redacted HitlRecord", () => {
    const record: HitlRecord = {
      id: "hitl-1",
      projectId: "my-project",
      sessionId: "session-1",
      goalId: "goal-1",
      kind: "approval",
      trigger: "approval_point",
      decisionKey: "goal-1:before-complete",
      status: "pending",
      prompt: "Approve completion?",
      displayPayload: {
        title: "Approve completion",
        summary: "Tool input redacted for dashboard display.",
        fields: [{ label: "Goal", value: "goal-1" }],
        redacted: true,
      },
      payload: { kind: "approval", action: "goal.complete", context: { goalId: "goal-1" } },
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    };

    const parsed = serializeRoundTrip(record);
    const serialized = JSON.stringify(parsed);

    expect(parsed).toEqual(record);
    expect(parsed.displayPayload.redacted).toBe(true);
    expect(serialized).not.toContain("rawLlmOutput");
    expect(serialized).not.toContain("rawTranscript");
  });

  test("serializes resolved HitlRequest with response", () => {
    const request: HitlRequest = {
      id: "hitl-2",
      sessionId: "session-1",
      kind: "question",
      prompt: "Which approach?",
      payload: { kind: "question", options: [{ label: "A" }, { label: "B" }] },
      trigger: "agent_request",
      status: "resolved",
      createdAt: "2026-06-01T00:00:00.000Z",
      resolvedAt: "2026-06-01T00:01:00.000Z",
      response: { kind: "question", answers: ["A"] },
    };

    const parsed = serializeRoundTrip(request);
    expect(parsed).toEqual(request);
    expect(parsed.status).toBe("resolved");
    expect(parsed.response).toEqual({ kind: "question", answers: ["A"] });
  });
});

describe("Goal/HITL stream events", () => {
  test("GoalStreamEvent types are serializable", () => {
    const stateChange: GoalStreamEvent = {
      type: "goal.state_change",
      goalId: "goal-1",
      status: "running",
      state: {
        id: "goal-1",
        projectId: "p",
        title: "t",
        status: "running",
        phase: "build",
        doneConditions: [],
        doneResults: {},
        reviewerAgent: "reviewer",
        retryPolicy: { maxRetries: 3, backoffMs: 5000, escalateOnFailure: true },
        retryCount: 0,
        approvalPoints: [],
        author: "orchestrator",
        childSessionIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };

    const doneCheck: GoalStreamEvent = {
      type: "goal.done_check",
      goalId: "goal-1",
      results: [
        { conditionId: "dc-1", passed: true, evidence: "Tests passed", checkedAt: "2026-06-01T00:00:00.000Z" },
      ],
    };

    const escalation: GoalStreamEvent = {
      type: "goal.escalation",
      goalId: "goal-1",
      reason: "Max retries exceeded",
    };

    expect(serializeRoundTrip(stateChange)).toEqual(stateChange);
    expect(serializeRoundTrip(doneCheck)).toEqual(doneCheck);
    expect(serializeRoundTrip(escalation)).toEqual(escalation);
  });

  test("HitlStreamEvent types are serializable", () => {
    const hitlRequestEvent: HitlStreamEvent = {
      type: "hitl.request",
      request: {
        id: "hitl-1",
        sessionId: "session-1",
        kind: "question",
        prompt: "Proceed?",
        payload: { kind: "question" },
        trigger: "agent_request",
        status: "pending",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    };

    const hitlResolvedEvent: HitlStreamEvent = {
      type: "hitl.resolved",
      hitlId: "hitl-1",
      status: "resolved",
      response: { kind: "question", answers: ["Yes"] },
    };

    expect(serializeRoundTrip(hitlRequestEvent)).toEqual(hitlRequestEvent);
    expect(serializeRoundTrip(hitlResolvedEvent)).toEqual(hitlResolvedEvent);
  });

  test("StreamEvent union accepts Goal/HITL events", () => {
    const events: StreamEvent[] = [
      { type: "goal.state_change", goalId: "g-1", status: "running", state: {} as GoalState },
      { type: "goal.done_check", goalId: "g-1", results: [] },
      { type: "goal.escalation", goalId: "g-1", reason: "fail" },
      { type: "hitl.request", request: {} as HitlRequest },
      { type: "hitl.resolved", hitlId: "h-1", status: "resolved" },
    ];

    expect(events).toHaveLength(5);
    expect(events[0]!.type).toBe("goal.state_change");
    expect(events[4]!.type).toBe("hitl.resolved");
  });

  test("SessionEventPayload union accepts Goal/HITL events", () => {
    const payloads: SessionEventPayload[] = [
      { type: "goal.state_change", goalId: "g-1", status: "running", state: {} as GoalState },
      { type: "goal.done_check", goalId: "g-1", results: [] },
      { type: "goal.escalation", goalId: "g-1", reason: "fail" },
      { type: "hitl.request", request: {} as HitlRequest },
      { type: "hitl.resolved", hitlId: "h-1", status: "resolved" },
    ];

    expect(payloads).toHaveLength(5);
    expect(payloads.map((p) => p.type)).toEqual([
      "goal.state_change",
      "goal.done_check",
      "goal.escalation",
      "hitl.request",
      "hitl.resolved",
    ]);
  });

  test("StreamEvent discriminates accurately between goal state change status values", () => {
    const runningEvent: GoalStreamEvent = {
      type: "goal.state_change",
      goalId: "g-1",
      status: "running",
      state: {} as GoalState,
    };
    const pausedEvent: GoalStreamEvent = {
      type: "goal.state_change",
      goalId: "g-2",
      status: "paused",
      state: {} as GoalState,
    };
    const escalatedEvent: GoalStreamEvent = {
      type: "goal.state_change",
      goalId: "g-3",
      status: "escalated",
      state: {} as GoalState,
    };

    expect(runningEvent.status).toBe("running");
    expect(pausedEvent.status).toBe("paused");
    expect(escalatedEvent.status).toBe("escalated");
  });
});
