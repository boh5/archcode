import { describe, expect, test } from "bun:test";
import type {
  AssistantSessionPart,
  FinalizedToolResult,
  SessionExecutionRecord,
  SessionMessage,
} from "@archcode/protocol";
import {
  buildMemoryExtractionInput,
  memoryContentHash,
  modelSafeInputBytes,
  removeAlreadySavedCandidates,
  type SavedMemoryMarker,
} from "./learning-input";
import {
  MAX_MEMORY_EXTRACTION_CANDIDATES,
  MAX_MEMORY_EXTRACTION_INPUT_BYTES,
  MAX_MEMORY_TOUCHED_FILES,
  type MemoryExtractionCandidate,
} from "./learning-state";
import { MemoryExtractionResultSchema } from "./learning-schemas";

const BINDING = {
  selection: { model: "test:model" },
  providerId: "test",
  modelId: "model",
  providerDisplayName: "Test",
  modelDisplayName: "Model",
  resolution: "profile_default" as const,
  modelRuntimeRevision: "runtime-1",
};
const MEMORY_POLICY = {
  policy: { useMemory: true, autoLearning: true },
  epoch: { bootId: "test-memory-boot", generation: 0 },
};

function result(preview: string, isError = false): FinalizedToolResult {
  const bytes = new TextEncoder().encode(preview).byteLength;
  return {
    isError,
    output: {
      preview,
      completeness: "complete",
      observed: { bytes, lines: 1 },
      canonical: { bytes, lines: 1 },
      stored: { bytes, lines: 1 },
      omitted: { bytes: 0, lines: 0 },
      recovery: { kind: "none" },
    },
  };
}

function userMessage(
  id: string,
  executionId: string,
  text: string,
): SessionMessage {
  return {
    id,
    role: "user",
    executionId,
    parts: [{ type: "text", id: `${id}:text`, text, createdAt: 1, completedAt: 1 }],
    createdAt: 1,
    completedAt: 1,
  };
}

function assistantMessage(
  id: string,
  executionId: string,
  text: string,
  parts: AssistantSessionPart[] = [],
): SessionMessage {
  return {
    id,
    role: "assistant",
    executionId,
    runOrdinal: 0,
    stepId: "step-final",
    outputPhase: "final_answer",
    parts: parts.length > 0
      ? parts
      : [{ type: "assistant-output", id: `${id}:output`, blockId: "output", text, createdAt: 1, completedAt: 1 }],
    createdAt: 1,
    completedAt: 1,
  };
}

function execution(
  id: string,
  status: SessionExecutionRecord["status"] = "completed",
  finalOutputStepId = "step-final",
): SessionExecutionRecord {
  const run = {
    ordinal: 0,
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    binding: BINDING,
    usageDelta: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 },
    settlement: { key: `run:session:${id}:0`, goalInstanceId: null },
  };
  if (status === "running") {
    return {
      id,
      memoryPolicy: MEMORY_POLICY,
      startedAt: 1,
      status,
      origin: "user_message",
      maxSteps: 50,
      durationMs: 0,
      runs: [{ ordinal: 0, startedAt: 1, binding: BINDING }],
    };
  }
  if (status === "suspended") {
    return {
      id,
      memoryPolicy: MEMORY_POLICY,
      startedAt: 1,
      status,
      origin: "user_message",
      maxSteps: 50,
      durationMs: 1,
      runs: [{ ...run }],
      suspension: { kind: "resume_pending", toolBatchId: "batch", readyAt: 4 },
    };
  }
  return {
    id,
    memoryPolicy: MEMORY_POLICY,
    startedAt: 1,
    status,
    origin: "user_message",
    maxSteps: 50,
    durationMs: 1,
    endedAt: 2,
    finalOutputStepId,
    runs: [{ ...run }],
    terminalSettlement: { key: `terminal:session:${id}`, goalInstanceId: null },
  };
}

function baseInput(overrides: Partial<Parameters<typeof buildMemoryExtractionInput>[0]> = {}) {
  const executionId = "execution-1";
  const messages: SessionMessage[] = [
    userMessage("user-1", executionId, "Use concise conclusions."),
    assistantMessage("assistant-1", executionId, "I will keep the answer concise."),
  ];
  return {
    messages,
    executions: [execution(executionId)],
    processedThroughMessageId: null,
    eligibleThroughMessageId: "assistant-1",
    preferences: "- concise answers",
    index: "- build_tools: Build Tools",
    contextLimitTokens: 100_000,
    ...overrides,
  };
}

function toolPart(
  id: string,
  toolName: string,
  input: unknown,
  output: string,
  isError = false,
) {
  return {
    type: "tool" as const,
    state: "completed" as const,
    id,
    toolCallId: `${id}:call`,
    toolName,
    input,
    result: result(output, isError),
    createdAt: 1,
    startedAt: 1,
    endedAt: 2,
  };
}

describe("memory extraction input", () => {
  test("includes the successful final answer, trusted read evidence, and saved marker", () => {
    const executionId = "execution-evidence";
    const user = userMessage("user-evidence", executionId, "Remember that concise answers are preferred.");
    const assistant = assistantMessage("assistant-evidence", executionId, "I will follow that preference.", [
      { type: "reasoning", id: "reasoning", blockId: "reasoning", text: "internal reasoning", createdAt: 1, completedAt: 1 },
      { type: "assistant-output", id: "final", blockId: "output", text: "I will follow that preference.", createdAt: 1, completedAt: 1 },
      toolPart("trusted", "file_read", { path: "README.md" }, "The project uses concise output."),
      toolPart("artifact-read", "output_read", { artifactId: "bash-output" }, "secret effectful artifact"),
      toolPart("artifact-search", "output_search", { artifactId: "bash-output" }, "effectful search match"),
      toolPart("effectful", "file_edit", { path: "README.md" }, "Changed the file"),
      toolPart("failed", "file_read", { path: "missing.md" }, "missing", true),
      toolPart("saved", "memory_write", { scope: "user", name: "preferences", content: "Concise answers are preferred." }, "Saved"),
    ]);
    const input = buildMemoryExtractionInput({
      ...baseInput({
        messages: [user, assistant],
        executions: [execution(executionId)],
        eligibleThroughMessageId: assistant.id,
      }),
    });

    expect(input.status).toBe("ready");
    if (input.status !== "ready") return;
    expect(input.prompt).toContain("final assistant:\nI will follow that preference.");
    expect(input.prompt).toContain("trusted read evidence (file_read):\nThe project uses concise output.");
    expect(input.prompt).toContain("saved-memory: scope=user target=preferences content_sha256=");
    expect(input.prompt).not.toContain("internal reasoning");
    expect(input.prompt).not.toContain("Changed the file");
    expect(input.prompt).not.toContain("secret effectful artifact");
    expect(input.prompt).not.toContain("effectful search match");
    expect(input.prompt).not.toContain("missing");
    expect(input.savedMarkers).toEqual([{
      scope: "user",
      target: "preferences",
      contentHash: memoryContentHash("Concise answers are preferred."),
    }]);
  });

  test("does not treat an incomplete, failed, or non-final execution as evidence", () => {
    const completeId = "complete";
    const failedId = "failed";
    const runningId = "running";
    const messages: SessionMessage[] = [
      userMessage("user-complete", completeId, "Keep a durable preference."),
      assistantMessage("assistant-complete", completeId, "Completed answer"),
      userMessage("user-failed", failedId, "Failed request"),
      assistantMessage("assistant-failed", failedId, "Should not be included"),
      userMessage("user-running", runningId, "Still running"),
      assistantMessage("assistant-running", runningId, "Also not included"),
    ];
    const input = buildMemoryExtractionInput(baseInput({
      messages,
      executions: [execution(completeId), execution(failedId, "failed"), execution(runningId, "running")],
      eligibleThroughMessageId: "assistant-running",
    }));

    expect(input.status).toBe("ready");
    if (input.status !== "ready") return;
    expect(input.prompt).toContain("Completed answer");
    expect(input.prompt).not.toContain("Should not be included");
    expect(input.prompt).not.toContain("Also not included");
  });

  test("adds the already-processed preceding final for a short consent reply without treating it as new evidence", () => {
    const previousExecutionId = "execution-previous";
    const currentExecutionId = "execution-current";
    const previousUser = userMessage("user-previous", previousExecutionId, "Should I remember that I prefer direct conclusions?");
    const previousFinal = assistantMessage("assistant-previous", previousExecutionId, "Please confirm whether I should remember that preference.");
    const currentUser = userMessage("user-current", currentExecutionId, "同意");
    const currentFinal = assistantMessage("assistant-current", currentExecutionId, "已记住你的偏好。");

    const input = buildMemoryExtractionInput({
      messages: [previousUser, previousFinal, currentUser, currentFinal],
      executions: [execution(previousExecutionId), execution(currentExecutionId)],
      processedThroughMessageId: previousFinal.id,
      eligibleThroughMessageId: currentFinal.id,
      preferences: "[none]",
      index: "[none]",
      contextLimitTokens: 100_000,
    });

    expect(input.status).toBe("ready");
    if (input.status !== "ready") return;
    expect(input.prompt).toContain("[preceding assistant context — already processed]");
    expect(input.prompt).toContain("Please confirm whether I should remember that preference.");
    expect(input.prompt).toContain("user:\n同意");
    expect(input.prompt).toContain("final assistant:\n已记住你的偏好。");
    expect(input.system).toContain("interpretation-only context");
    expect(input.system).toContain("not itself new Memory evidence");
  });

  test("does not invent meaning for a short consent reply when its final answer is absent", () => {
    const previousExecutionId = "execution-previous";
    const currentExecutionId = "execution-current";
    const previousUser = userMessage("user-previous", previousExecutionId, "Should I remember that I prefer direct conclusions?");
    const previousFinal = assistantMessage("assistant-previous", previousExecutionId, "Please confirm whether I should remember that preference.");
    const currentUser = userMessage("user-current", currentExecutionId, "同意");
    const currentWindow = [currentUser].flatMap((message) => message.parts.flatMap((part) => (
      part.type === "text" ? [part.text] : []
    )));

    const input = buildMemoryExtractionInput({
      messages: [previousUser, previousFinal, currentUser],
      executions: [execution(previousExecutionId), execution(currentExecutionId)],
      processedThroughMessageId: previousFinal.id,
      eligibleThroughMessageId: currentUser.id,
      preferences: "[none]",
      index: "[none]",
      contextLimitTokens: 100_000,
    });

    expect(currentWindow).toEqual(["同意"]);
    expect(input).toMatchObject({ status: "blocked", reason: "input_budget" });
    expect(JSON.stringify(input)).not.toContain("direct conclusions");
    expect(JSON.stringify(input)).not.toContain("remember that preference");
  });

  test("keeps complete preferences and index while truncating only older conversation", () => {
    const messages: SessionMessage[] = [];
    const executions: SessionExecutionRecord[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = `execution-${i}`;
      messages.push(userMessage(`user-${i}`, id, `new durable user evidence ${i}`));
      messages.push(assistantMessage(`assistant-${i}`, id, `new durable answer ${i}`));
      executions.push(execution(id));
    }
    const input = buildMemoryExtractionInput({
      messages,
      executions,
      processedThroughMessageId: null,
      eligibleThroughMessageId: "assistant-4",
      preferences: "complete preferences: do not omit this",
      index: "complete index: build_tools and runtime",
      contextLimitTokens: 100_000,
      hardMaxBytes: 1_100,
    });

    expect(input.status).toBe("ready");
    if (input.status !== "ready") return;
    expect(input.truncatedOlderConversation).toBe(true);
    expect(input.prompt).toContain("complete preferences: do not omit this");
    expect(input.prompt).toContain("complete index: build_tools and runtime");
    expect(input.prompt).toContain("new durable answer 4");
    expect(input.prompt).not.toContain("new durable answer 0");
    expect(input.inputBytes).toBeLessThanOrEqual(1_100);
  });

  test("blocks when the latest evidence group cannot fit instead of truncating the manifest", () => {
    const input = buildMemoryExtractionInput(baseInput({
      preferences: "p".repeat(500),
      index: "i".repeat(500),
      contextLimitTokens: 100_000,
      hardMaxBytes: 700,
    }));
    expect(input).toMatchObject({ status: "blocked", reason: "input_budget", maxBytes: 700 });
  });

  test("bounds candidate count, touched files, and candidate content through the strict schema", () => {
    const candidates = Array.from({ length: MAX_MEMORY_EXTRACTION_CANDIDATES + 1 }, (_, index) => ({
      scope: "project" as const,
      target: `topic_${index}`,
      title: `Topic ${index}`,
      description: "Durable topic",
      type: "project" as const,
      content: "durable content",
      basis: "inferred" as const,
      intent: "add" as const,
    }));
    expect(MemoryExtractionResultSchema.safeParse({ candidates }).success).toBe(false);
    const touched = Array.from({ length: MAX_MEMORY_TOUCHED_FILES + 1 }, (_, index) => ({
      scope: "project" as const,
      target: `topic_${index}`,
      title: `Topic ${index}`,
      description: "Durable topic",
      type: "project" as const,
      content: "durable content",
      basis: "inferred" as const,
      intent: "add" as const,
    }));
    expect(MemoryExtractionResultSchema.safeParse({ candidates: touched }).success).toBe(false);
  });

  test("rejects reserved project topic targets at extraction schema boundary", () => {
    for (const target of ["index", "preferences"]) {
      expect(MemoryExtractionResultSchema.safeParse({
        candidates: [{
          scope: "project",
          target,
          title: "Reserved",
          description: "Must not become a topic",
          type: "project",
          content: "durable content",
          basis: "inferred",
          intent: "add",
        }],
      }).success).toBe(false);
    }
  });

  test("removes successful memory_write candidates and emits one forced NOOP per target", () => {
    const duplicate: MemoryExtractionCandidate = {
      scope: "user",
      target: "preferences",
      content: "Concise answers are preferred.",
      basis: "inferred",
      intent: "add",
    };
    const fresh: MemoryExtractionCandidate = {
      scope: "project",
      target: "build_tools",
      title: "Build Tools",
      description: "Build conventions",
      type: "project",
      content: "Use the repository build script.",
      basis: "inferred",
      intent: "add",
    };
    const markers: SavedMemoryMarker[] = [{
      scope: "user",
      target: "preferences",
      contentHash: memoryContentHash(duplicate.content),
    }];
    expect(removeAlreadySavedCandidates([duplicate, fresh], markers)).toEqual({
      candidates: [fresh],
      forcedNoopTargets: [{ scope: "user", target: "preferences" }],
    });
  });

  test("uses a conservative model budget and never returns a negative safe size", () => {
    expect(modelSafeInputBytes(100_000)).toBe(284_640);
    expect(modelSafeInputBytes(1)).toBe(0);
    expect(MAX_MEMORY_EXTRACTION_INPUT_BYTES).toBe(64 * 1_024);
  });
});
