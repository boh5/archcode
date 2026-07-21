import { describe, expect, test } from "bun:test";
import { HITL_RECENT_TERMINAL_LIMIT, hitlIdentityKey } from "./types";
import { createEmptySessionStats } from "./usage";
import type {
  CompressionBlockCommittedEvent,
  CompressionBlockPart,
  CompressionBlockSnapshot,
  CompressionRefMapUpdatedEvent,
  CompressionStateSnapshot,
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
  FinalizedToolResult,
  ServerConfigUpdate,
} from "./types";

function serializeRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function compositeIdentity(event: GlobalSessionEventEnvelope): string {
  return `${event.slug}:${event.sessionId}:${event.eventId}`;
}

describe("current tool and config wire types", () => {
  test("round-trips the strict finalized tool result contract", () => {
    const result: FinalizedToolResult = {
      isError: false,
      output: {
        preview: "head\ntail",
        completeness: "partial",
        observed: { bytes: 100, lines: 10 },
        canonical: { bytes: 90, lines: 10 },
        stored: { bytes: 20, lines: 2 },
        omitted: { bytes: 70, lines: 8 },
        recovery: {
          kind: "artifact",
          outputRef: "x".repeat(22),
          expiresAt: 123,
          canRead: true,
          canSearch: true,
        },
      },
      details: {
        process: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          durationMs: 12,
        },
        presentations: [{ kind: "ask_user", answers: [{ question: "Continue?", answers: ["yes"] }] }],
      },
    };

    expect(serializeRoundTrip(result)).toEqual(result);
  });

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
      profiles: {} as ServerConfigUpdate["profiles"],
      mcp: { servers: { docs: { url: "https://mcp.example.test", timeout: 30000 } } },
      integrations: { github: { enabled: true, tokenEnv: "GITHUB_TOKEN" } },
    } satisfies ServerConfigUpdate;

    expect(serializeRoundTrip(config)).toEqual(config);
  });

  test("represents model settings without Prompt behavior capability metadata", () => {
    const config = {
      provider: {
        local: {
          npm: "@ai-sdk/openai-compatible",
          name: "Local",
          options: { baseURL: "http://localhost:8090/v1" },
          models: {
            demo: {
              name: "Demo",
              limit: { context: 128000, output: 16000 },
              modalities: { input: ["text"], output: ["text"] },
            },
          },
        },
      },
      profiles: {} as ServerConfigUpdate["profiles"],
    } satisfies ServerConfigUpdate;

    expect(serializeRoundTrip(config)).toEqual(config);
  });
});

describe("global SSE wire protocol types", () => {
  test("uses an unreasoned resource.changed contract for Automations and Project Todos", () => {
    const events: GlobalSSEResourceChangedEvent[] = [{
      type: "resource.changed",
      projectSlug: "project-a",
      resourceType: "todo",
      resourceId: "todo-1",
      createdAt: 1,
    }, {
      type: "resource.changed",
      projectSlug: "project-a",
      resourceType: "automation",
      resourceId: "automation-1",
      createdAt: 2,
    }, {
      type: "resource.changed",
      projectSlug: "project-a",
      resourceType: "todo",
      resourceId: "todo-1",
      createdAt: 3,
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
      agentName: "lead",
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
    expect(parsed.agentName).toBe("lead");
  });

  test("distinguishes matching event IDs by composite identity", () => {
    const first: GlobalSessionEventEnvelope<TextDeltaEvent> = {
      type: "event",
      slug: "proj-a",
      sessionId: "s1",
      eventId: 42,
      createdAt: 1,
      payload: { type: "text-delta", text: "hello" },
      agentName: "lead",
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
        agentName: "lead",
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
        ownerSessionId: "session-1",
        rootSessionId: "root-1",
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

  test("HitlView remains display-safe", () => {
    const view: HitlView = {
      hitlId: "hitl-1",
      owner: { type: "session", id: "session-1" },
      source: { type: "tool_permission", toolCallId: "call-1", toolName: "bash" },
      status: "pending",
      displayPayload: { title: "Goal blocked", summary: "Budget warning", redacted: true },
      persistentApprovalEligible: false,
      allowedActions: ["approve", "deny", "cancel"],
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    };

    const serialized = JSON.stringify(serializeRoundTrip(view));

    expect(serialized).toContain("Goal blocked");
    expect(serialized).toContain('"persistentApprovalEligible":false');
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
      createdAt: "2026-07-14T01:00:00.000Z",
    };

    expect(statuses).toEqual(["active", "paused", "disabled"]);
    expect(serializeRoundTrip(automation)).toEqual(automation);
    expect(serializeRoundTrip(invocation)).toEqual(invocation);
  });
});
