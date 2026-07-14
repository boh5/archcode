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
  HitlView,
  HitlResponse,
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
  ToolDiffMetadata,
  ServerConfigUpdate,
} from "./types";

function serializeRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function compositeIdentity(event: GlobalSessionEventEnvelope): string {
  return `${event.slug}:${event.sessionId}:${event.eventId}`;
}

describe("current tool and config wire types", () => {
  test("round-trips unversioned ToolDiff metadata", () => {
    const diffs: ToolDiffMetadata = {
      files: [{
        path: "src/index.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        hunks: [{
          header: "@@ -1 +1 @@",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [{ type: "delete", content: "old" }, { type: "add", content: "new" }],
        }],
      }],
    };

    expect(serializeRoundTrip(diffs)).toEqual(diffs);
  });

  test("represents only editable MCP and GitHub config fields", () => {
    const config = {
      provider: {},
      agents: {} as ServerConfigUpdate["agents"],
      mcp: { servers: { docs: { url: "https://mcp.example.test", timeout: 30000 } } },
      integrations: { github: { enabled: true, tokenEnv: "GITHUB_TOKEN" } },
    } satisfies ServerConfigUpdate;

    expect(serializeRoundTrip(config)).toEqual(config);
  });
});

describe("global SSE wire protocol types", () => {
  test("uses an unreasoned resource.changed contract for Goals and Automations", () => {
    const events: GlobalSSEResourceChangedEvent[] = [{
      type: "resource.changed",
      projectSlug: "project-a",
      resourceType: "goal",
      resourceId: "goal-1",
      createdAt: 1,
    }, {
      type: "resource.changed",
      projectSlug: "project-a",
      resourceType: "automation",
      resourceId: "automation-1",
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
    expect(parsed.payload.type).toBe("text-delta");
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
        entries: [],
        createdAt: 3,
      },
      {
        type: "hitl.event",
        projectSlug: "proj-a",
        hitlId: "hitl-1",
        createdAt: 4,
        payload: { type: "hitl.request" },
        view: {} as HitlView,
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
      id: "goal-1",
      projectSlug: "my-project",
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
      appliedBudgetHitlIds: ["hitl-approval-1"],
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

  test("Goal budget approvals and NOT_DONE receipts round-trip", () => {
    const state: GoalState = {
      id: "goal-2",
      projectSlug: "my-project",
      createdFromSessionId: "session-source",
      title: "Fix bug",
      objective: "Resolve the reported bug.",
      acceptanceCriteria: "The bug no longer reproduces.",
      useWorktree: false,
      status: "running",
      budget: {
        status: "warning",
        updatedAt: "2026-06-01T00:00:00.000Z",
      },
      budgetApproval: {
        hitlId: "hitl-1",
        approvalPoint: "warning-1",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
      attempt: 1,
      reviewGeneration: 1,
      appliedBudgetHitlIds: [],
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
    expect(parsed.budgetApproval?.approvalPoint).toBe("warning-1");
    expect(parsed.review?.verdict).toBe("NOT_DONE");
    expect(parsed.review?.unresolvedItems).toEqual(["Clarify expected behavior"]);
    expect(parsed.lastError?.name).toBe("QuestionBlockedError");
  });
});

describe("HITL types", () => {
  test("uses a bounded recent-terminal retention limit", () => {
    expect(HITL_RECENT_TERMINAL_LIMIT).toBe(20);
  });

  test("keys HITL identity by owner and id", () => {
    const first = hitlIdentityKey({
      owner: { type: "session", id: "session-a" },
      hitlId: "shared-id",
    });
    const second = hitlIdentityKey({
      owner: { type: "session", id: "session-b" },
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

  test("serializes HitlResponse budget variant", () => {
    const response: HitlResponse = {
      type: "budget_decision",
      decision: "denied",
      comment: "Needs more tests",
    };

    const parsed = serializeRoundTrip(response);
    expect(parsed).toEqual(response);
    expect(parsed.decision).toBe("denied");
  });

  test("HitlView remains display-safe", () => {
    const view: HitlView = {
      hitlId: "hitl-1",
      owner: { type: "goal", id: "goal-1" },
      source: { type: "goal_budget", approvalPoint: "before_complete" },
      status: "pending",
      displayPayload: { title: "Goal blocked", summary: "Budget warning", redacted: true },
      allowedActions: ["approve", "deny", "cancel"],
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    };

    const serialized = JSON.stringify(serializeRoundTrip(view));

    expect(serialized).toContain("Goal blocked");
    expect(serialized).not.toContain("workspaceRoot");
    expect(serialized).not.toContain("rawToolInput");
    expect(serialized).not.toContain("rawCheckpoint");
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
      projectSlug: "project-1",
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
