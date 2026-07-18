import { describe, expect, test } from "bun:test";
import {
  isGlobalSSEHitlRealtimeEvent,
  isGlobalSSEResourceChangedEvent,
  isSessionEventPayload,
  isStreamEvent,
  isTerminalChildSessionStatus,
} from "./guards";
import type { SessionEventPayload } from "./types";

const displayPayload = { title: "Question", redacted: true as const };
const requestedModelSelection = {
  mode: "agent_default" as const,
  selection: { model: "test:model" },
};
const binding = {
  selection: { model: "test:model" },
  providerId: "test",
  modelId: "model",
  providerDisplayName: "Test",
  modelDisplayName: "Model",
  resolution: "agent_default" as const,
  modelRuntimeRevision: "runtime-1",
};
const refMap = {
  messageRefsById: { message: "m0001" as const },
  messageIdsByRef: { m0001: "message" },
  blockRefsById: { block: "b1" as const },
  blockIdsByRef: { b1: "block" },
  nextMessageIndex: 2,
  nextBlockIndex: 2,
};
const compressionBlock = {
  id: "block",
  ref: "b1" as const,
  status: "active" as const,
  strategy: "dynamic-range" as const,
  trigger: "model_tool_call" as const,
  range: {
    startMessageId: "message",
    endMessageId: "message",
    startRef: "m0001" as const,
    endRef: "m0001" as const,
    startIndex: 0,
    endIndex: 0,
  },
  summary: "summary",
  childBlockRefs: [],
  protectedRefs: [],
  createdAt: 1,
  updatedAt: 1,
};
const compressionState = {
  refMap,
  blocksByRef: { b1: compressionBlock },
  activeBlockRefs: ["b1" as const],
  inactiveBlockRefs: [],
  supersededBlockRefs: [],
  failures: [],
};
const pendingMessage = {
  id: "message-queued",
  clientRequestId: "request-queued",
  content: "queued",
  source: "user" as const,
  state: "queued" as const,
  revision: 0,
  acceptedAt: 1,
  updatedAt: 1,
  requestedModelSelection,
};
const steeringMessage = {
  ...pendingMessage,
  state: "steering" as const,
  revision: 1,
  targetExecutionId: "execution-1",
};
const canonicalMessage = {
  id: pendingMessage.id,
  role: "user" as const,
  parts: [{ type: "text" as const, id: "part-1", text: "queued", createdAt: 1, completedAt: 2 }],
  createdAt: 1,
  completedAt: 2,
  executionId: "execution-1",
  clientRequestId: pendingMessage.clientRequestId,
  modelAudit: { requested: requestedModelSelection, actual: binding.selection },
};

const validPayloads = [
  { type: "shutdown", reason: "restart" },
  { type: "execution-start", executionId: "execution-1", binding, origin: "user_message" },
  { type: "execution-end", status: "waiting_for_human", blockedByHitlIds: ["hitl-1"] },
  { type: "session.cwd_changed", previousCwd: "/old", cwd: "/new" },
  { type: "session.model_selection_changed", modelSelection: { revision: 1, override: { model: "test:model" } } },
  { type: "session.message_accepted", message: pendingMessage },
  { type: "session.message_edited", message: { ...pendingMessage, content: "edited", revision: 1 } },
  { type: "session.message_deleted", messageId: pendingMessage.id, clientRequestId: pendingMessage.clientRequestId, revision: 1, deletedAt: 2 },
  { type: "session.message_steer_claimed", message: steeringMessage },
  { type: "session.message_steer_rolled_back", message: { ...pendingMessage, revision: 2 } },
  { type: "session.messages_committed", executionId: "execution-1", messages: [canonicalMessage] },
  { type: "execution-stop-requested", executionId: "execution-1", timestamp: 2 },
  { type: "system-notice", message: "notice" },
  { type: "text-start" },
  { type: "text-delta", text: "hello" },
  { type: "text-end" },
  { type: "reasoning-start" },
  { type: "reasoning-delta", text: "thinking" },
  { type: "reasoning-end" },
  { type: "tool-input-start", toolCallId: "call-1", toolName: "file_read" },
  { type: "tool-call", toolCallId: "call-1", toolName: "file_read", input: { path: "README.md" } },
  { type: "tool-input-resolved", toolCallId: "call-1", toolName: "file_read", input: { path: "README.md" } },
  { type: "tool-attempt", toolCallId: "call-1", toolName: "file_write", attemptId: "attempt-1", timestamp: 1, destructive: false },
  { type: "tool-result", toolCallId: "call-1", toolName: "file_read", output: "ok", isError: false, meta: {} },
  { type: "tool-child-session-link", link: { parentSessionId: "parent", parentToolCallId: "call", toolName: "delegate", childSessionId: "child", childAgentName: "explore", title: "Explore child", depth: 1, background: false, status: "completed", createdAt: 1 } },
  { type: "todo-write", todos: [{ id: "todo-1", content: "work", status: "in_progress" }] },
  { type: "reminder", reminder: { id: "reminder-1", source: { type: "subagent_completed", sessionId: "child" }, delivery: "auto_inject", content: "done", createdAt: 1, consumedAt: null } },
  { type: "reminder-consumed", reminderIds: ["reminder-1"] },
  { type: "step-start", step: 1 },
  { type: "step-end", step: 1, finishReason: "stop", usage: {} },
  { type: "execution-error", step: 1, error: "failed" },
  { type: "llm-retry", scope: "short", visibility: "internal", attempt: 1, errorKind: "network", message: "retry", nextRetryAt: 2 },
  { type: "llm-recovery", scope: "session", visibility: "session", attempt: 1, message: "recovered" },
  { type: "llm-recovery-failed", scope: "session", visibility: "session", attempt: 1, errorKind: "network", message: "failed", statusCode: 500 },
  { type: "compact", summary: "summary", tailStartId: "message-2" },
  { type: "compression.block_committed", block: compressionBlock, state: compressionState },
  { type: "compression.block_failed", failure: { id: "failure-1", reason: "overlap", failedAt: 1 }, state: compressionState },
  { type: "compression.ref_map_updated", refMap, updatedAt: 1 },
] satisfies SessionEventPayload[];

describe("protocol event guards", () => {
  test("keeps one valid fixture for every current Session event payload type", () => {
    expect(validPayloads.map((event) => event.type).sort()).toEqual([
      "compact",
      "compression.block_committed",
      "compression.block_failed",
      "compression.ref_map_updated",
      "execution-end",
      "execution-error",
      "execution-start",
      "execution-stop-requested",
      "llm-recovery",
      "llm-recovery-failed",
      "llm-retry",
      "reasoning-delta",
      "reasoning-end",
      "reasoning-start",
      "reminder",
      "reminder-consumed",
      "session.cwd_changed",
      "session.message_accepted",
      "session.message_deleted",
      "session.message_edited",
      "session.message_steer_claimed",
      "session.message_steer_rolled_back",
      "session.messages_committed",
      "session.model_selection_changed",
      "shutdown",
      "step-end",
      "step-start",
      "system-notice",
      "text-delta",
      "text-end",
      "text-start",
      "todo-write",
      "tool-attempt",
      "tool-call",
      "tool-child-session-link",
      "tool-input-resolved",
      "tool-input-start",
      "tool-result",
    ]);
  });

  test("recognizes stream events and excludes wire-only events", () => {
    expect(isStreamEvent({ type: "text-delta", text: "ok" })).toBe(true);
    expect(isStreamEvent({ type: "shutdown" } as never)).toBe(false);
  });

  test("rejects malformed Session event payloads without throwing", () => {
    expect(validPayloads.filter((event) => !isSessionEventPayload(event)).map((event) => event.type)).toEqual([]);
    expect(validPayloads.every(isSessionEventPayload)).toBe(true);
    for (const event of validPayloads) {
      expect(isSessionEventPayload({ ...event, legacy: true })).toBe(false);
    }
    expect(isSessionEventPayload({ type: "text-delta" })).toBe(false);
    expect(isSessionEventPayload({ type: "text-delta", text: 1 })).toBe(false);
    expect(isSessionEventPayload({ type: "tool-child-session-link", link: { ...validPayloads[23]!.link, legacy: true } })).toBe(false);
    expect(isSessionEventPayload({ type: "compression.block_committed", block: { ...compressionBlock, range: { ...compressionBlock.range, endIndex: "0" } } })).toBe(false);
    expect(isSessionEventPayload({ type: "hitl.request" })).toBe(false);
    expect(isSessionEventPayload({})).toBe(false);
    expect(isSessionEventPayload(null)).toBe(false);
    expect(isSessionEventPayload("text-start")).toBe(false);
  });

  test("recognizes terminal child statuses", () => {
    expect(isTerminalChildSessionStatus("completed")).toBe(true);
    expect(isTerminalChildSessionStatus("running")).toBe(false);
    expect(isTerminalChildSessionStatus("waiting_for_human")).toBe(false);
  });

  test("accepts only the current global HITL and resource change contracts", () => {
    const view = {
      hitlId: "hitl-1",
      owner: { type: "session", id: "session-1" },
      source: { type: "ask_user", toolCallId: "call-1" },
      status: "pending",
      displayPayload,
      persistentApprovalEligible: false,
      allowedActions: ["answer", "cancel"],
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const hitlEvent = {
      type: "hitl.event",
      projectSlug: "project",
      hitlId: "hitl-1",
      createdAt: 1,
      payload: { type: "hitl.request" },
      view,
    };
    const resourceEvent = {
      type: "resource.changed",
      projectSlug: "project",
      resourceType: "goal",
      resourceId: "goal-1",
      createdAt: 1,
    };

    expect(isGlobalSSEHitlRealtimeEvent(hitlEvent)).toBe(true);
    expect(isGlobalSSEHitlRealtimeEvent({ ...hitlEvent, payload: { type: "hitl.request", status: "pending" } })).toBe(false);
    expect(isGlobalSSEHitlRealtimeEvent({ ...hitlEvent, hitlId: "other" })).toBe(false);
    expect(isGlobalSSEHitlRealtimeEvent({ type: "hitl.event" })).toBe(false);
    expect(isGlobalSSEResourceChangedEvent(resourceEvent)).toBe(true);
    expect(isGlobalSSEResourceChangedEvent({ ...resourceEvent, resourceType: "todo", resourceId: "todo-1" })).toBe(true);
    expect(isGlobalSSEResourceChangedEvent({ ...resourceEvent, reason: "created" })).toBe(false);
    expect(isGlobalSSEResourceChangedEvent({ type: "resource.changed" })).toBe(false);
  });
});
