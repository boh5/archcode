import { describe, expect, test } from "bun:test";
import {
  isGlobalSSEHitlRealtimeEvent,
  isGlobalSSEHitlSnapshotEvent,
  isGlobalSSEResourceChangedEvent,
  isGlobalSSEUpdateChangedEvent,
  isSessionEventPayload,
  isStreamEvent,
  isTerminalChildSessionStatus,
} from "./guards";
import {
  COMPRESSION_SUMMARY_SECTION_NAMES,
  type CompressionSummarySnapshot,
} from "./compression";
import type { SessionEventPayload } from "./types";

function compressionSummary(currentObjective: string): CompressionSummarySnapshot {
  return {
    sections: Object.fromEntries(
      COMPRESSION_SUMMARY_SECTION_NAMES.map((section) => [
        section,
        section === "Current Objective" ? currentObjective : "None",
      ]),
    ) as CompressionSummarySnapshot["sections"],
  };
}

const displayPayload = { title: "Question", redacted: true as const };
const requestedModelSelection = {
  mode: "profile_default" as const,
  selection: { model: "test:model" },
};
const binding = {
  selection: { model: "test:model" },
  providerId: "test",
  modelId: "model",
  providerDisplayName: "Test",
  modelDisplayName: "Model",
  resolution: "profile_default" as const,
  modelRuntimeRevision: "runtime-1",
};
const memoryPolicy = {
  policy: { useMemory: true, autoLearning: true },
  epoch: { bootId: "test-memory-boot", generation: 0 },
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
  summary: compressionSummary("summary"),
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
  attachments: [],
  source: "user" as const,
  state: "queued" as const,
  revision: 0,
  acceptedAt: 1,
  updatedAt: 1,
  requestedModelSelection,
  executionSkillNames: [],
};
const attachment = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "report<&>.pdf",
  mediaType: "application/pdf",
  sizeBytes: 123,
  kind: "file" as const,
};
const steeringMessage = {
  ...pendingMessage,
  state: "steering" as const,
  revision: 1,
  targetExecutionId: "execution-1",
  targetRunOrdinal: 0,
  targetModelAudit: { requested: requestedModelSelection, actual: binding.selection },
  claimedAt: 2,
};
const canonicalMessage = {
  id: pendingMessage.id,
  role: "user" as const,
  parts: [{ type: "text" as const, id: "part-1", text: "queued", createdAt: 1, completedAt: 2 }],
  createdAt: 1,
  completedAt: 2,
  executionId: "execution-1",
  runOrdinal: 0,
  clientRequestId: pendingMessage.clientRequestId,
  modelAudit: { requested: requestedModelSelection, actual: binding.selection },
};
const finalizedResult = {
  isError: false,
  output: {
    preview: "ok",
    completeness: "complete" as const,
    observed: { bytes: 2, lines: 1 },
    canonical: { bytes: 2, lines: 1 },
    stored: { bytes: 2, lines: 1 },
    omitted: { bytes: 0, lines: 0 },
    recovery: { kind: "none" as const },
  },
};
const validPayloads = [
  { type: "shutdown", reason: "restart" },
  { type: "execution-start", executionId: "execution-1", binding, executionSkills: [], memoryPolicy, origin: "user_message", maxSteps: 50 },
  {
    type: "execution-suspended",
    executionId: "execution-1",
    suspension: { kind: "hitl", toolBatchId: "batch-1", blockerIds: ["hitl-1"] },
    runEndedAt: 2,
    runUsageDelta: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 },
    runSettlement: { key: "run:session:execution-1:0", goalInstanceId: null },
  },
  {
    type: "execution-suspension-updated",
    executionId: "execution-1",
    suspension: { kind: "resume_pending", toolBatchId: "batch-1", readyAt: 3 },
  },
  { type: "execution-resumed", executionId: "execution-1", runOrdinal: 1, binding },
  {
    type: "execution-end",
    executionId: "execution-1",
    terminalStatus: "completed",
    endedAt: 5,
    runEndedAt: 5,
    runUsageDelta: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 },
    runSettlement: { key: "run:session:execution-1:1", goalInstanceId: null },
    terminalSettlement: { key: "terminal:session:execution-1", goalInstanceId: null },
  },
  { type: "session.cwd_changed", previousCwd: "/old", cwd: "/new" },
  { type: "session.model_selection_changed", modelSelection: { revision: 1, override: { model: "test:model" } } },
  {
    type: "session.goal_changed",
    action: "usage_recorded",
    instanceId: crypto.randomUUID(),
    generation: 1,
    goal: {
      instanceId: crypto.randomUUID(), generation: 1, objective: "Finish it", status: "active",
      usage: { tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 }, executionTimeMs: 0, executionCount: 0 },
      settlementReceipts: [],
      createdAt: 1, activatedAt: 1, updatedAt: 1,
    },
    status: "active",
    reason: "Usage changed",
    occurredAt: 1,
  },
  { type: "session.message_accepted", message: pendingMessage },
  { type: "session.message_edited", message: { ...pendingMessage, content: "edited", revision: 1 } },
  { type: "session.message_deleted", messageId: pendingMessage.id, clientRequestId: pendingMessage.clientRequestId, revision: 1, deletedAt: 2 },
  { type: "session.message_steer_claimed", message: steeringMessage },
  { type: "session.message_steer_rolled_back", message: { ...pendingMessage, revision: 2 } },
  { type: "session.messages_committed", executionId: "execution-1", messages: [canonicalMessage] },
  { type: "execution-stop-requested", executionId: "execution-1", timestamp: 2 },
  { type: "system-notice", message: "notice" },
  { type: "text-start", stepId: "step-1", blockId: "output-1" },
  { type: "text-delta", stepId: "step-1", blockId: "output-1", text: "hello" },
  { type: "text-end", stepId: "step-1", blockId: "output-1" },
  { type: "reasoning-start", stepId: "step-1", blockId: "reasoning-1" },
  { type: "reasoning-delta", stepId: "step-1", blockId: "reasoning-1", text: "thinking" },
  { type: "reasoning-end", stepId: "step-1", blockId: "reasoning-1" },
  { type: "tool-input-start", toolCallId: "call-1", toolName: "file_read" },
  { type: "tool-call", toolCallId: "call-1", toolName: "file_read", input: { path: "README.md" } },
  { type: "tool-input-resolved", toolCallId: "call-1", toolName: "file_read", input: { path: "README.md" } },
  { type: "tool-attempt", toolCallId: "call-1", toolName: "file_write", attemptId: "attempt-1", timestamp: 1, destructive: false },
  {
    type: "tool-result",
    toolCallId: "call-1",
    toolName: "file_edit",
    settledAt: 2,
    result: {
      ...finalizedResult,
      details: {
        presentations: [{
          kind: "diff" as const,
          files: [{ path: "large.ts", status: "modified" as const, hunks: [] }],
          simplified: true as const,
        }],
      },
    },
  },
  { type: "tool-child-session-link", link: { parentSessionId: "parent", parentToolCallId: "call", toolName: "delegate", childSessionId: "child", childExecutionId: "child-execution", childAgentName: "explore", childProfile: "fast", childSkillNames: [], title: "Explore child", depth: 1, background: false, status: "completed", createdAt: 1 } },
  { type: "tool-output-delta", toolCallId: "call-2", toolName: "bash", delta: "live", omittedBytes: 0, liveLimitReached: false },
  { type: "todo-write", todos: [{ id: "todo-1", content: "work", status: "in_progress" }] },
  {
    type: "reminder",
    reminder: {
      id: "6f424736-b35d-43e3-9b39-4e7512121f01",
      source: {
        type: "session_goal_changed",
        notice: {
          type: "goal-notice",
          id: "6f424736-b35d-43e3-9b39-4e7512121f01",
          action: "created",
          authority: "user_control",
          instanceId: "39719088-a050-4631-ab35-d98315970ac7",
          generation: 1,
          goal: { objective: "Finish it", status: "active" },
          createdAt: 1,
        },
      },
      delivery: "model_context",
      content: "Session Goal created",
      createdAt: 1,
      consumedAt: null,
    },
  },
  { type: "reminder-consumed", reminderIds: ["reminder-1"] },
  { type: "step-start", stepId: "step-1", step: 1 },
  { type: "step-end", stepId: "step-1", step: 1, finishReason: "stop", usage: {} },
  { type: "execution-error", stepId: "step-1", step: 1, error: "failed" },
  { type: "llm-retry", scope: "short", visibility: "internal", attempt: 1, errorKind: "network", message: "retry", nextRetryAt: 2 },
  { type: "llm-recovery", scope: "session", visibility: "session", attempt: 1, message: "recovered" },
  { type: "llm-recovery-failed", scope: "session", visibility: "session", attempt: 1, errorKind: "network", message: "failed", statusCode: 500 },
  { type: "compact", summary: "summary", tailStartId: "message-2" },
  { type: "compression.block_committed", block: compressionBlock, state: compressionState },
  { type: "compression.block_failed", failure: { id: "failure-1", reason: "overlap", failedAt: 1 }, state: compressionState },
  { type: "compression.ref_map_updated", refMap, updatedAt: 1 },
  { type: "prompt-trace", trace: { version: "2", status: "compiled", hash: "a".repeat(64), sections: [{ name: "Shared Kernel", source: "prompt/shared-kernel@2", hash: "b".repeat(64) }], skills: { status: "present", available: { includedEntries: [], omittedCount: 0, renderedText: "- none", byteLength: 6 }, active: [{ name: "review-work", source: "/skills/review-work/SKILL.md" }] }, visibleTools: ["file_read"], agentsMd: "present", memory: "absent", mcp: { context7: "partial-warning" }, warnings: ["one tool was skipped"] } },
] satisfies SessionEventPayload[];

describe("protocol event guards", () => {
  test("rejects Prompt Skill projections with forged or oversized byte counts", () => {
    const event = validPayloads.find((candidate) => candidate.type === "prompt-trace")!;
    const traceEvent = structuredClone(event);
    if (traceEvent.type !== "prompt-trace") throw new Error("Expected prompt trace fixture");
    traceEvent.trace.skills.available.byteLength = 5;
    expect(isSessionEventPayload(traceEvent)).toBe(false);

    const oversized = structuredClone(event);
    if (oversized.type !== "prompt-trace") throw new Error("Expected prompt trace fixture");
    oversized.trace.skills.available.renderedText = "x".repeat(8_001);
    oversized.trace.skills.available.byteLength = 8_001;
    expect(isSessionEventPayload(oversized)).toBe(false);
  });

  test("accepts strict attachment-only pending and canonical messages", () => {
    expect(isSessionEventPayload({
      type: "session.message_accepted",
      message: { ...pendingMessage, content: "", attachments: [attachment] },
    })).toBe(true);
    expect(isSessionEventPayload({
      type: "session.messages_committed",
      executionId: "execution-1",
      messages: [{
        ...canonicalMessage,
        parts: [{
          type: "text",
          id: "part-1",
          text: "",
          createdAt: 1,
          completedAt: 2,
        }, {
          type: "attachment",
          id: "attachment-part-1",
          attachment,
          createdAt: 1,
          completedAt: 2,
        }],
      }],
    })).toBe(true);
  });

  test("rejects empty attachment input, duplicate ids, and descriptor extensions", () => {
    expect(isSessionEventPayload({
      type: "session.message_accepted",
      message: { ...pendingMessage, content: "", attachments: [] },
    })).toBe(false);
    expect(isSessionEventPayload({
      type: "session.message_accepted",
      message: { ...pendingMessage, attachments: [attachment, attachment] },
    })).toBe(false);
    expect(isSessionEventPayload({
      type: "session.message_accepted",
      message: {
        ...pendingMessage,
        attachments: [{ ...attachment, absolutePath: "/private/content" }],
      },
    })).toBe(false);
  });

  test("keeps one valid fixture for every current Session event payload type", () => {
    expect(validPayloads.map((event) => event.type).sort()).toEqual([
      "compact",
      "compression.block_committed",
      "compression.block_failed",
      "compression.ref_map_updated",
      "execution-end",
      "execution-error",
      "execution-resumed",
      "execution-start",
      "execution-stop-requested",
      "execution-suspended",
      "execution-suspension-updated",
      "llm-recovery",
      "llm-recovery-failed",
      "llm-retry",
      "prompt-trace",
      "reasoning-delta",
      "reasoning-end",
      "reasoning-start",
      "reminder",
      "reminder-consumed",
      "session.cwd_changed",
      "session.goal_changed",
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
      "tool-output-delta",
      "tool-result",
    ]);
  });

  test("recognizes stream events and excludes wire-only events", () => {
    expect(isStreamEvent({ type: "text-delta", stepId: "step-1", blockId: "output-1", text: "ok" })).toBe(true);
    expect(isStreamEvent({ type: "shutdown" } as never)).toBe(false);
  });

  test("rejects blank provider block ids at the wire boundary", () => {
    for (const type of ["text-start", "text-end", "reasoning-start", "reasoning-end"] as const) {
      expect(isSessionEventPayload({ type, stepId: "step-1", blockId: " \t" })).toBe(false);
    }
    for (const type of ["text-delta", "reasoning-delta"] as const) {
      expect(isSessionEventPayload({ type, stepId: "step-1", blockId: "\n", text: "content" })).toBe(false);
    }
  });

  test("rejects malformed Session event payloads without throwing", () => {
    expect(validPayloads.filter((event) => !isSessionEventPayload(event)).map((event) => event.type)).toEqual([]);
    expect(isSessionEventPayload({
      type: "execution-start",
      executionId: "execution-without-policy",
      binding,
      origin: "user_message",
      maxSteps: 50,
    })).toBe(false);
    expect(validPayloads.every(isSessionEventPayload)).toBe(true);
    const goalReminderEvent = validPayloads.find((event) =>
      event.type === "reminder" && event.reminder.source.type === "session_goal_changed"
    );
    expect(goalReminderEvent).toBeDefined();
    if (goalReminderEvent?.type === "reminder"
      && goalReminderEvent.reminder.source.type === "session_goal_changed") {
      expect(isSessionEventPayload({
        ...goalReminderEvent,
        reminder: {
          ...goalReminderEvent.reminder,
          source: {
            ...goalReminderEvent.reminder.source,
            notice: {
              ...goalReminderEvent.reminder.source.notice,
              generation: 2,
            },
          },
        },
      })).toBe(false);
      expect(isSessionEventPayload({
        ...goalReminderEvent,
        reminder: {
          ...goalReminderEvent.reminder,
          id: "not-a-uuid",
          source: {
            ...goalReminderEvent.reminder.source,
            notice: {
              ...goalReminderEvent.reminder.source.notice,
              id: "not-a-uuid",
            },
          },
        },
      })).toBe(false);
      expect(isSessionEventPayload({
        ...goalReminderEvent,
        reminder: {
          ...goalReminderEvent.reminder,
          source: {
            ...goalReminderEvent.reminder.source,
            notice: {
              ...goalReminderEvent.reminder.source.notice,
              instanceId: "not-a-uuid",
            },
          },
        },
      })).toBe(false);
    }
    for (const event of validPayloads) {
      expect(isSessionEventPayload({ ...event, unexpectedField: true })).toBe(false);
    }
    expect(isSessionEventPayload({
      type: "tool-output-delta",
      toolCallId: "call-1",
      toolName: "file_read",
      delta: "live",
      omittedBytes: 0,
      liveLimitReached: false,
    })).toBe(false);
    expect(isSessionEventPayload({
      type: "tool-output-delta",
      toolCallId: "call-1",
      toolName: "bash",
      delta: "🙂".repeat(1025),
      omittedBytes: 0,
      liveLimitReached: false,
    })).toBe(false);
    expect(isSessionEventPayload({
      type: "tool-output-delta",
      toolCallId: "call-1",
      toolName: "bash",
      delta: "live",
      omittedBytes: -1,
      liveLimitReached: false,
    })).toBe(false);
    expect(isSessionEventPayload({
      type: "tool-output-delta",
      toolCallId: "call-1",
      toolName: "bash",
      delta: "live",
      omittedBytes: 0,
      liveLimitReached: false,
      extra: true,
    })).toBe(false);
    expect(isSessionEventPayload({
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "file_read",
      result: finalizedResult,
    })).toBe(false);
    expect(isSessionEventPayload({
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "file_read",
      settledAt: 2,
      result: {
        ...finalizedResult,
        output: {
          ...finalizedResult.output,
          recovery: {
            kind: "source",
            toolName: "file_read",
            nextInput: { first: "a".repeat(8 * 1024), second: "b".repeat(8 * 1024) },
          },
        },
      },
    })).toBe(false);
    expect(isSessionEventPayload({
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "git_diff",
      settledAt: 2,
      result: {
        ...finalizedResult,
        details: {
          presentations: [{
            kind: "diff",
            files: [{
              path: "large.ts",
              additions: 1.5,
              hunks: [{
                header: "@@",
                oldStart: 1,
                oldLines: 0,
                newStart: 1,
                newLines: 65,
                lines: Array.from({ length: 65 }, () => ({ type: "add", content: "x".repeat(4 * 1024) })),
              }],
            }],
          }],
        },
      },
    })).toBe(false);
    expect(isSessionEventPayload({
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "git_diff",
      settledAt: 2,
      result: {
        ...finalizedResult,
        details: {
          presentations: [{
            kind: "diff",
            simplified: false,
            files: [{ path: "small.ts", additions: 1, hunks: [] }],
          }],
        },
      },
    })).toBe(false);
    expect(isSessionEventPayload({
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "file_read",
      settledAt: 2,
      result: { ...finalizedResult, meta: {} },
    })).toBe(false);
    expect(isSessionEventPayload({
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "file_read",
      settledAt: 2,
      result: {
        ...finalizedResult,
        output: { ...finalizedResult.output, recovery: { kind: "source", toolName: "file_read", nextInput: { bad: undefined } } },
      },
    })).toBe(false);
    expect(isSessionEventPayload({
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "file_read",
      settledAt: 2,
      result: {
        ...finalizedResult,
        output: {
          ...finalizedResult.output,
          recovery: { kind: "artifact", outputRef: "local/path", expiresAt: 1, canRead: true, canSearch: true },
        },
      },
    })).toBe(false);
    expect(isSessionEventPayload({
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "file_read",
      settledAt: 2,
      result: { ...finalizedResult, details: { arbitrary: "metadata escape" } },
    })).toBe(false);
    expect(isSessionEventPayload({ type: "tool-child-session-link", link: { ...validPayloads[23]!.link, unexpectedField: true } })).toBe(false);
    expect(isSessionEventPayload({
      type: "tool-child-session-link",
      link: { ...validPayloads[23]!.link, durationMs: 1 },
    })).toBe(false);
    expect(isSessionEventPayload({ type: "compression.block_committed", block: { ...compressionBlock, range: { ...compressionBlock.range, endIndex: "0" } } })).toBe(false);
    expect(isSessionEventPayload({
      type: "compression.block_committed",
      block: { ...compressionBlock, summary: compressionSummary("Unresolved (b1)") },
    })).toBe(false);
    expect(isSessionEventPayload({
      type: "compression.block_committed",
      block: { ...compressionBlock, summary: compressionSummary("") },
    })).toBe(false);
    expect(isSessionEventPayload({
      type: "compression.block_committed",
      block: { ...compressionBlock, childBlockRefs: ["b1", "b1"] },
    })).toBe(false);
    expect(isSessionEventPayload({
      type: "compression.block_committed",
      block: {
        ...compressionBlock,
        summary: {
          sections: {
            ...compressionBlock.summary.sections,
            unexpected: "field",
          },
        },
      },
    })).toBe(false);
    expect(isSessionEventPayload({ type: "hitl.request" })).toBe(false);
    expect(isSessionEventPayload({ ...validPayloads.at(-1), trace: { ...(validPayloads.at(-1) as any).trace, mcp: { docs: "unknown" } } })).toBe(false);
    expect(isSessionEventPayload({})).toBe(false);
    expect(isSessionEventPayload(null)).toBe(false);
    expect(isSessionEventPayload("text-start")).toBe(false);
  });

  test("requires the claim-time resolution root for Execution Skill bindings", () => {
    const event = {
      type: "execution-start",
      executionId: "execution-skill-root",
      binding,
      origin: "user_message",
      maxSteps: 50,
      memoryPolicy,
      executionSkills: [{
        name: "codemap",
        source: "project-archcode",
        digest: "a".repeat(64),
        resolutionRoot: "/workspace/.worktrees/session",
      }],
    } as const;

    expect(isSessionEventPayload(event)).toBe(true);
    expect(isSessionEventPayload({
      ...event,
      executionSkills: [{
        name: "codemap",
        source: "project-archcode",
        digest: "a".repeat(64),
      }],
    })).toBe(false);
    expect(isSessionEventPayload({
      ...event,
      executionSkills: [{ ...event.executionSkills[0], digest: "not-a-sha256-digest" }],
    })).toBe(false);
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
      ownerSessionId: "session-1",
      rootSessionId: "root-1",
      createdAt: 1,
      payload: { type: "hitl.request" },
      view,
    };
    const resourceEvent = {
      type: "resource.changed",
      projectSlug: "project",
      resourceType: "automation",
      resourceId: "automation-1",
      createdAt: 1,
    };

    expect(isGlobalSSEHitlRealtimeEvent(hitlEvent)).toBe(true);
    expect(isGlobalSSEHitlRealtimeEvent({ ...hitlEvent, payload: { type: "hitl.request", status: "pending" } })).toBe(false);
    expect(isGlobalSSEHitlRealtimeEvent({ ...hitlEvent, hitlId: "other" })).toBe(false);
    expect(isGlobalSSEHitlRealtimeEvent({ type: "hitl.event" })).toBe(false);
    const hitlSnapshot = {
      type: "hitl.snapshot",
      projectSlugs: ["project"],
      entries: [{
        projectSlug: "project",
        hitlId: "hitl-1",
        ownerSessionId: "session-1",
        rootSessionId: "root-1",
        view,
      }],
      createdAt: 1,
    };
    expect(isGlobalSSEHitlSnapshotEvent(hitlSnapshot)).toBe(true);
    expect(isGlobalSSEHitlSnapshotEvent({ ...hitlSnapshot, entries: [{ projectSlug: "project", view }] })).toBe(false);
    expect(isGlobalSSEResourceChangedEvent(resourceEvent)).toBe(true);
    expect(isGlobalSSEResourceChangedEvent({ ...resourceEvent, resourceType: "todo", resourceId: "todo-1" })).toBe(true);
    expect(isGlobalSSEResourceChangedEvent({ ...resourceEvent, resourceType: "session", resourceId: "session-1" })).toBe(true);
    expect(isGlobalSSEResourceChangedEvent({ ...resourceEvent, resourceType: "goal", resourceId: "goal-1" })).toBe(false);
    expect(isGlobalSSEResourceChangedEvent({ ...resourceEvent, reason: "created" })).toBe(false);
    expect(isGlobalSSEResourceChangedEvent({ type: "resource.changed" })).toBe(false);
  });

  test("accepts only coherent update status change events", () => {
    const updateEvent = {
      type: "update.changed",
      createdAt: 10,
      status: {
        currentVersion: "1.0.0",
        phase: "downloading",
        managed: true,
        restartSupported: true,
        updateAvailable: true,
        restartRequired: false,
        latest: {
          version: "1.1.0",
          releaseUrl: "https://github.com/boh5/archcode/releases/tag/v1.1.0",
        },
        lastCheckedAt: 9,
        progress: {
          phase: "downloading",
          downloadedBytes: 25,
          totalBytes: 100,
        },
      },
    };

    expect(isGlobalSSEUpdateChangedEvent(updateEvent)).toBe(true);
    expect(isGlobalSSEUpdateChangedEvent({
      ...updateEvent,
      status: {
        ...updateEvent.status,
        progress: { ...updateEvent.status.progress, phase: "installing" },
      },
    })).toBe(false);
    expect(isGlobalSSEUpdateChangedEvent({
      ...updateEvent,
      status: {
        ...updateEvent.status,
        progress: { ...updateEvent.status.progress, downloadedBytes: 101 },
      },
    })).toBe(false);
    expect(isGlobalSSEUpdateChangedEvent({
      ...updateEvent,
      status: { ...updateEvent.status, unexpected: true },
    })).toBe(false);
    for (const field of ["latest", "progress", "error"] as const) {
      expect(isGlobalSSEUpdateChangedEvent({
        ...updateEvent,
        status: { ...updateEvent.status, [field]: null },
      })).toBe(false);
    }
  });
});
