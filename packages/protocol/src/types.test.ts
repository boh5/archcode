import { describe, expect, test } from "bun:test";
import { HITL_RECENT_TERMINAL_LIMIT } from "./types";
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
  GlobalSSEHeartbeatEvent,
  GlobalSSELaggedEvent,
  GlobalSSEResetEvent,
  GlobalSSEShutdownEvent,
  GlobalSessionEventEnvelope,
  StreamEvent,
  TextDeltaEvent,
  ToolAttemptEvent,
  SessionEventPayload,
  LoopConfig,
  LoopCleanupPolicy,
  LoopJobSummary,
  LoopProjectConfig,
  LoopStatus,
  LoopScheduleSpec,
  LoopRunReport,
  LoopRunReportStatus,
  LoopRunTrigger,
  LoopTriggerHealth,
  LoopTriggerSpec,
  LoopWorktreeArtifact,
  LoopGoalTemplate,
  LoopState,
  LoopStreamEvent,
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
      {
        type: "hitl.snapshot",
        projectSlugs: ["proj-a"],
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
      "draft",
      "running",
      "blocked",
      "reviewing",
      "done",
      "not_done",
      "failed",
      "cancelled",
    ];

    expect(statuses).toEqual([
      "draft",
      "running",
      "blocked",
      "reviewing",
      "done",
      "not_done",
      "failed",
      "cancelled",
    ]);
  });

  test("GoalState serializes the natural-language contract with review evidence", () => {
    const state: GoalState = {
      id: "goal-1",
      projectId: "my-project",
      title: "Implement auth",
      objective: "Build the requested authentication flow.",
      acceptanceCriteria: "Users can sign in and invalid credentials are rejected.",
      status: "done",
      attempt: 2,
      budget: {
        status: "ok",
        usedTokens: 1200,
        maxTokens: 5000,
        updatedAt: "2026-01-01T00:04:00.000Z",
      },
      pendingHitlIds: [],
      approvalRefs: ["hitl-approval-1"],
      mainSessionId: "session-main",
      childSessionIds: ["session-build", "session-review"],
      review: {
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
      id: "goal-2",
      projectId: "my-project",
      title: "Fix bug",
      objective: "Resolve the reported bug.",
      acceptanceCriteria: "The bug no longer reproduces.",
      status: "blocked",
      blocker: {
        kind: "question",
        summary: "Need user clarification on expected behavior.",
        hitlId: "hitl-1",
        resumeStatus: "running",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
      attempt: 1,
      pendingHitlIds: ["hitl-1"],
      approvalRefs: [],
      childSessionIds: [],
      review: {
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

    expect(parsed.status).toBe("blocked");
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
      source: { type: "goal_approval", goalId: "goal-1", approvalPoint: "before_complete" },
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
      owner: { projectSlug: "my-project", ownerType: "loop", ownerId: "loop-1" },
      ancestry: { rootSessionId: "session-root", loopId: "loop-1", projectionPath: ["loop", "goal"] },
      source: { type: "loop_blocker", loopId: "loop-1", reason: "budget warning" },
      status: "pending",
      displayPayload: { title: "Loop blocked", summary: "Budget warning", redacted: true },
      allowedActions: ["approve", "deny", "cancel"],
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    };

    const serialized = JSON.stringify(serializeRoundTrip(projection));

    expect(serialized).toContain("Loop blocked");
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
      id: "goal-1",
      projectId: "p",
      title: "Implement feature",
      objective: "Implement the requested feature.",
      acceptanceCriteria: "Feature behavior satisfies the request.",
      status: "running",
      attempt: 1,
      pendingHitlIds: [],
      approvalRefs: [],
      childSessionIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
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
      record: { ...hitlRequestEvent.request, status: "resume_claimed" },
    };

    expect(serializeRoundTrip(hitlRequestEvent)).toEqual(hitlRequestEvent);
    expect(serializeRoundTrip(hitlUpdatedEvent)).toEqual(hitlUpdatedEvent);
    expect(serializeRoundTrip(hitlResolvedEvent)).toEqual(hitlResolvedEvent);
  });
});

describe("Loop types", () => {
  function serializeRoundTrip<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  test("LoopStatus values are correct", () => {
    const statuses: LoopStatus[] = ["active", "paused", "disabled", "error"];
    expect(statuses).toHaveLength(4);
    expect(statuses).toContain("active");
    expect(statuses).toContain("paused");
    expect(statuses).toContain("disabled");
    expect(statuses).toContain("error");
  });

  test("LoopScheduleSpec accepts manual, interval, and cron", () => {
    const manual: LoopScheduleSpec = { kind: "manual" };
    const interval: LoopScheduleSpec = { kind: "interval", everyMs: 60000 };
    const cron: LoopScheduleSpec = { kind: "cron", expression: "*/15 * * * *" };

    expect(serializeRoundTrip(manual)).toEqual(manual);
    expect(serializeRoundTrip(interval)).toEqual(interval);
    expect(serializeRoundTrip(cron)).toEqual(cron);
    expect(interval.everyMs).toBe(60000);
    expect(cron.expression).toBe("*/15 * * * *");
  });

  test("LoopTriggerSpec accepts automation trigger filters", () => {
    const triggers: LoopTriggerSpec[] = [
      { kind: "on_commit", branch: "main", cadenceMs: 60000 },
      { kind: "on_pr", baseBranch: "main", prScope: "review_requested", cadenceMs: 60000 },
      { kind: "on_ci_fail", baseBranch: "main", checkName: "test", workflowName: "ci", cadenceMs: 60000 },
    ];

    expect(serializeRoundTrip(triggers)).toEqual(triggers);
    expect(triggers.map((trigger) => trigger.kind)).toEqual(["on_commit", "on_pr", "on_ci_fail"]);
  });

  test("LoopRunReportStatus values are correct", () => {
    const statuses: LoopRunReportStatus[] = ["running", "succeeded", "failed", "skipped", "cancelled", "budget_exceeded", "needs_user"];
    expect(statuses).toHaveLength(7);
    expect(statuses).toContain("running");
    expect(statuses).toContain("succeeded");
    expect(statuses).toContain("failed");
    expect(statuses).toContain("skipped");
    expect(statuses).toContain("cancelled");
    expect(statuses).toContain("budget_exceeded");
    expect(statuses).toContain("needs_user");
  });

  test("LoopRunTrigger values are correct", () => {
    const triggers: LoopRunTrigger[] = ["manual", "interval", "cron", "on_commit", "on_pr", "on_ci_fail"];
    expect(triggers).toHaveLength(6);
    expect(triggers).toContain("manual");
    expect(triggers).toContain("interval");
    expect(triggers).toContain("cron");
    expect(triggers).toContain("on_commit");
    expect(triggers).toContain("on_pr");
    expect(triggers).toContain("on_ci_fail");
  });

  test("Loop project coordinator config carries maxConcurrent", () => {
    const projectConfig: LoopProjectConfig = { coordinator: { maxConcurrent: 2 } };

    expect(serializeRoundTrip(projectConfig)).toEqual(projectConfig);
    expect(projectConfig.coordinator.maxConcurrent).toBe(2);
  });

  test("Loop cleanup and job metadata types serialize", () => {
    const cleanupPolicy: LoopCleanupPolicy = {
      deleteUnchangedWorktrees: true,
      preserveChangedArtifacts: true,
      maxPreservedWorktrees: 5,
    };
    const artifact: LoopWorktreeArtifact = {
      path: "report.md",
      status: "modified",
      sizeBytes: 120,
      sha: "abc123",
    };
    const job: LoopJobSummary = {
      jobId: "job-1",
      loopId: "loop-1",
      status: "blocked",
      triggerKind: "on_pr",
      subjectKey: "pr:test-owner/test-repo#42",
      dedupeKey: "loop-1:on_pr:pr:test-owner/test-repo#42",
      branchKey: "test-owner/test-repo:feature",
      queuedAt: 1000,
      attempts: 1,
      blockedReason: "needs_user",
      worktreePath: "/tmp/worktree",
      baseSha: "base",
      resolvedHeadSha: "head",
      cleanupState: "preserved",
      observedArtifacts: [artifact],
    };
    const health: LoopTriggerHealth = {
      triggerKind: "on_ci_fail",
      status: "healthy",
      cadenceMs: 60000,
      lastCheckedAt: 2000,
      missedCount: 0,
    };

    expect(serializeRoundTrip(cleanupPolicy)).toEqual(cleanupPolicy);
    expect(serializeRoundTrip(job).observedArtifacts).toEqual([artifact]);
    expect(serializeRoundTrip(health)).toEqual(health);
  });

  test("LoopRunReport serializes round-trip", () => {
    const report: LoopRunReport = {
      runId: "run-1",
      loopId: "loop-1",
      status: "succeeded",
      trigger: "manual",
      startedAt: 1000,
      endedAt: 2000,
      sessionId: "session-1",
      summary: "Completed successfully",
      jobId: "job-1",
      triggerKind: "cron",
      subjectKey: "cron:1000",
      dedupeKey: "loop-1:cron:cron:1000",
      branchKey: "test-owner/test-repo:main",
      worktreePath: "/tmp/worktree",
      baseSha: "base",
      resolvedHeadSha: "head",
      missedCount: 1,
      cleanupState: "cleaned",
      observedArtifacts: [{ path: "report.md", status: "observed" }],
    };

    const parsed = serializeRoundTrip(report);
    expect(parsed).toEqual(report);
    expect(parsed.status).toBe("succeeded");
    expect(parsed.trigger).toBe("manual");
    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.jobId).toBe("job-1");
    expect(parsed.observedArtifacts).toEqual([{ path: "report.md", status: "observed" }]);
  });

  test("LoopRunReport with error and skippedReason serializes", () => {
    const report: LoopRunReport = {
      runId: "run-2",
      loopId: "loop-1",
      status: "skipped",
      trigger: "interval",
      startedAt: 1000,
      skippedReason: "Loop already active",
    };

    const parsed = serializeRoundTrip(report);
    expect(parsed).toEqual(report);
    expect(parsed.status).toBe("skipped");
    expect(parsed.skippedReason).toBe("Loop already active");
  });

  test("LoopGoalTemplate has only natural-language Goal fields", () => {
    const template: LoopGoalTemplate = {
      title: "Implement feature",
      objective: "Implement the feature according to the loop finding.",
      acceptanceCriteria: "The feature is implemented and reviewed against the finding.",
    };

    const parsed = serializeRoundTrip(template);
    expect(parsed).toEqual(template);
    expect(parsed.title).toBe("Implement feature");
    expect(parsed.objective).toContain("feature");
    expect(parsed.acceptanceCriteria).toContain("reviewed");
  });

  test("LoopGoalTemplate rejects non-natural-language Goal DSL fields at type level", () => {
    // @ts-expect-error - old typed criteria arrays are not valid on LoopGoalTemplate
    const invalid: LoopGoalTemplate = { title: "t", objective: "o", acceptanceCriteria: "a", doneConditions: [] };
    expect(invalid).toBeDefined();
  });

  test("LoopConfig serializes minimal manual session report loop", () => {
    const config: LoopConfig = {
      templateId: "watch_report",
      title: "Daily Triage",
      description: "Inspect git status and produce report",
      schedule: { kind: "manual" },
      approvalPolicy: "interactive",
      limits: { maxIterationsPerRun: 10 },
      taskPrompt: "Inspect git status and report findings",
    };

    const parsed = serializeRoundTrip(config);
    expect(parsed).toEqual(config);
    expect(parsed.schedule).toEqual({ kind: "manual" });
    expect(parsed.templateId).toBe("watch_report");
    expect(parsed.approvalPolicy).toBe("interactive");
    expect(parsed.limits.maxIterationsPerRun).toBe(10);
  });

  test("LoopConfig serializes interval goal loop with inline template", () => {
    const config: LoopConfig = {
      templateId: "goal_runner",
      title: "Changelog Drafter",
      schedule: { kind: "interval", everyMs: 3600000 },
      approvalPolicy: "interactive",
      limits: { maxIterationsPerRun: 5 },
      goalTemplate: {
        title: "Draft changelog",
        objective: "Draft a changelog from recent project changes.",
        acceptanceCriteria: "The changelog draft summarizes user-facing changes in natural language.",
      },
    };

    const parsed = serializeRoundTrip(config);
    expect(parsed).toEqual(config);
    expect(parsed.schedule).toEqual({ kind: "interval", everyMs: 3600000 });
    expect(parsed.templateId).toBe("goal_runner");
    expect(parsed.goalTemplate).toBeDefined();
    expect(parsed.goalTemplate!.title).toBe("Draft changelog");
  });

  test("LoopConfig accepts cron, triggers, and cleanup policy", () => {
    const config: LoopConfig = {
      templateId: "pr_babysitter",
      title: "PR watcher",
      schedule: { kind: "cron", expression: "*/15 * * * *" },
      approvalPolicy: "interactive",
      limits: { maxIterationsPerRun: 1 },
      triggers: [{ kind: "on_pr", cadenceMs: 60000, baseBranch: "main" }],
      cleanupPolicy: { deleteUnchangedWorktrees: true, preserveChangedArtifacts: true },
    };

    expect(serializeRoundTrip(config)).toEqual(config);
    expect(config.triggers?.[0]?.kind).toBe("on_pr");
  });

  test("LoopConfig rejects goalTemplateId at type level", () => {
    // @ts-expect-error - goalTemplateId is not a valid LoopConfig field
    const invalid: LoopConfig = { templateId: "goal_runner", title: "t", schedule: { kind: "manual" }, approvalPolicy: "interactive", limits: { maxIterationsPerRun: 1 }, goalTemplateId: "goal-123" };
    expect(invalid).toBeDefined();
  });

  test("LoopState serializes round-trip with no readinessScore", () => {
    const state: LoopState = {
      loopId: "loop-1",
      projectId: "my-project",
      config: {
        templateId: "watch_report",
        title: "Daily Triage",
        schedule: { kind: "manual" },
        approvalPolicy: "interactive",
        limits: { maxIterationsPerRun: 10 },
      },
      status: "active",
      createdAt: 1000,
      updatedAt: 1000,
      runCount: 0,
      stateVersion: 1,
    };

    const parsed = serializeRoundTrip(state);
    expect(parsed).toEqual(state);
    expect(parsed.status).toBe("active");
    expect(parsed.runCount).toBe(0);
    expect(parsed.stateVersion).toBe(1);
    expect(parsed.readinessScore).toBeUndefined();
  });

  test("LoopState with lastRun and currentRun serializes", () => {
    const state: LoopState = {
      loopId: "loop-1",
      projectId: "my-project",
      config: {
        templateId: "watch_report",
        title: "Changelog",
        schedule: { kind: "interval", everyMs: 60000 },
        approvalPolicy: "interactive",
        limits: { maxIterationsPerRun: 5 },
      },
      status: "active",
      createdAt: 1000,
      updatedAt: 3000,
      lastRun: {
        runId: "run-1",
        loopId: "loop-1",
        status: "succeeded",
        trigger: "interval",
        startedAt: 2000,
        endedAt: 3000,
        summary: "Completed",
      },
      currentRun: {
        runId: "run-2",
        loopId: "loop-1",
        status: "running",
        trigger: "interval",
        startedAt: 4000,
      },
      nextRunAt: 10000,
      runCount: 1,
      stateVersion: 2,
      generatedStateSummary: "Loop has run 1 time(s). Last run: succeeded.",
      currentJob: {
        jobId: "job-2",
        loopId: "loop-1",
        status: "running",
        triggerKind: "interval",
        subjectKey: "interval:4000",
        dedupeKey: "loop-1:interval:interval:4000",
        queuedAt: 3500,
        startedAt: 4000,
        attempts: 1,
      },
      queuedJobs: [],
      triggerHealth: [{ triggerKind: "on_pr", status: "healthy", cadenceMs: 60000 }],
      cleanupState: "not_started",
    };

    const parsed = serializeRoundTrip(state);
    expect(parsed).toEqual(state);
    expect(parsed.lastRun!.status).toBe("succeeded");
    expect(parsed.currentRun!.status).toBe("running");
    expect(parsed.nextRunAt).toBe(10000);
    expect(parsed.runCount).toBe(1);
    expect(parsed.generatedStateSummary).toContain("succeeded");
    expect(parsed.currentJob?.jobId).toBe("job-2");
    expect(parsed.triggerHealth?.[0]?.triggerKind).toBe("on_pr");
  });

  test("LoopStreamEvent types are serializable", () => {
    const stateChange: LoopStreamEvent = {
      type: "loop.state_change",
      loopId: "loop-1",
      status: "active",
      state: {
        loopId: "loop-1",
        projectId: "p",
        config: {
          templateId: "watch_report",
          title: "t",
          schedule: { kind: "manual" },
          approvalPolicy: "interactive",
          limits: { maxIterationsPerRun: 10 },
        },
        status: "active",
        createdAt: 1000,
        updatedAt: 1000,
        runCount: 0,
        stateVersion: 1,
      },
    };

    const runAppended: LoopStreamEvent = {
      type: "loop.run_appended",
      loopId: "loop-1",
      report: {
        runId: "run-1",
        loopId: "loop-1",
        status: "succeeded",
        trigger: "manual",
        startedAt: 2000,
        endedAt: 3000,
        summary: "Done",
      },
    };

    expect(serializeRoundTrip(stateChange)).toEqual(stateChange);
    expect(serializeRoundTrip(runAppended)).toEqual(runAppended);
  });

  test("StreamEvent union accepts Loop events", () => {
    const events: StreamEvent[] = [
      {
        type: "loop.state_change",
        loopId: "loop-1",
        status: "active",
        state: {} as LoopState,
      },
      {
        type: "loop.run_appended",
        loopId: "loop-1",
        report: {} as LoopRunReport,
      },
    ];

    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("loop.state_change");
    expect(events[1]!.type).toBe("loop.run_appended");
  });

  test("SessionSummary can carry loopId alongside goalId", () => {
    const summary: SessionSummary = {
      sessionId: "session-1",
      rootSessionId: "session-1",
      goalId: "goal-1",
      loopId: "loop-1",
      createdAt: 1000,
    };

    const parsed = serializeRoundTrip(summary);
    expect(parsed.goalId).toBe("goal-1");
    expect(parsed.loopId).toBe("loop-1");
  });

  test("SessionSummary without loopId still works", () => {
    const summary: SessionSummary = {
      sessionId: "session-1",
      rootSessionId: "session-1",
      goalId: "goal-1",
      createdAt: 1000,
    };

    const parsed = serializeRoundTrip(summary);
    expect(parsed.goalId).toBe("goal-1");
    expect(parsed.loopId).toBeUndefined();
  });

  test("Session can carry loopId alongside goalId", () => {
    const session: Session = {
      id: "session-1",
      rootSessionId: "session-1",
      goalId: "goal-1",
      loopId: "loop-1",
      createdAt: 1000,
    };

    const parsed = serializeRoundTrip(session);
    expect(parsed.goalId).toBe("goal-1");
    expect(parsed.loopId).toBe("loop-1");
  });

  test("Session without loopId still works", () => {
    const session: Session = {
      id: "session-1",
      rootSessionId: "session-1",
      goalId: "goal-1",
      createdAt: 1000,
    };

    const parsed = serializeRoundTrip(session);
    expect(parsed.goalId).toBe("goal-1");
    expect(parsed.loopId).toBeUndefined();
  });

  test("readinessScore remains absent from LoopState fixtures", () => {
    const state: LoopState = {
      loopId: "loop-1",
      projectId: "p",
      config: {
        templateId: "watch_report",
        title: "t",
        schedule: { kind: "manual" },
        approvalPolicy: "interactive",
        limits: { maxIterationsPerRun: 10 },
      },
      status: "active",
      createdAt: 1000,
      updatedAt: 1000,
      runCount: 0,
      stateVersion: 1,
    };

    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("readinessScore");
  });
});
