import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { StoreApi } from "zustand";
import type { SessionStoreState, StoredMessage } from "../../store/types";
import { storeManager } from "../../store/store";
import type { ToolExecutionContext } from "../types";
import { createTestToolRegistryFixture } from "../test-registry";
import { expectSettledResult } from "../test-results";
import { createTestProjectContext } from "../test-project-context";
import { TOOL_COMPRESS } from "../names";
import { compressTool } from "./compress";

const workspaceRoot = join(tmpdir(), `archcode-compress-test-${crypto.randomUUID()}`);
mkdirSync(workspaceRoot, { recursive: true });
const registryFixture = createTestToolRegistryFixture({ descriptors: [compressTool] });

afterAll(async () => {
  await registryFixture.dispose();
  await rm(workspaceRoot, { recursive: true, force: true });
});

function makeStore(): StoreApi<SessionStoreState> {
  const store = storeManager.create(`compress-test-${crypto.randomUUID()}`, workspaceRoot, { source: { kind: "direct" }, agentName: "lead" });
  store.setState({ messages: messages() });
  store.getState().toModelMessages();
  return store;
}

function makeCtx(store: StoreApi<SessionStoreState>): ToolExecutionContext {
  return {
    store,
    storeManager,
    toolName: TOOL_COMPRESS,
    toolCallId: "compress-call-1",
    input: {},
    step: 1,
    executionId: "test-execution",
    runOrdinal: 0,
    toolBatchId: "test-tool-batch",
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set([TOOL_COMPRESS]),
    cwd: workspaceRoot,
    projectContext: createTestProjectContext(workspaceRoot),
  };
}

function messages(): StoredMessage[] {
  return [
    message("msg-1", "user", "one"),
    message("msg-2", "assistant", "two"),
    message("msg-3", "user", "three"),
    message("msg-4", "assistant", "four"),
    message("msg-5", "user", "five"),
    message("msg-6", "assistant", "six"),
  ];
}

function message(
  id: string,
  role: StoredMessage["role"],
  text: string,
): StoredMessage {
  if (role === "user") {
    return {
      id,
      role,
      parts: [{
        type: "text",
        id: `${id}-text`,
        text,
        createdAt: 1,
        completedAt: 2,
      }],
      createdAt: 1,
      completedAt: 2,
    };
  }
  return {
    id,
    role,
    executionId: `execution:${id}`,
    runOrdinal: 0,
    stepId: `step:${id}`,
    outputPhase: "commentary",
    parts: [{
      type: "assistant-output",
      id: `${id}-output`,
      blockId: `${id}-block`,
      text,
      createdAt: 1,
      completedAt: 2,
    }],
    createdAt: 1,
    completedAt: 2,
  };
}

function summary(childBlockRefs: string[] = []) {
  return {
    sections: {
      "Current Objective": childBlockRefs.length > 0 ? `Continue after (${childBlockRefs[0]})` : "Continue task",
      "User Constraints": "Preserve constraints",
      "Decisions Made": "Use dynamic compression",
      "Open Tasks": "Continue",
      "Important Files": "compress.ts",
      "Tool Results": "None",
      "Errors/Unknown Results": "None",
      "Protected Refs": "None",
      "Child Block Refs": childBlockRefs.length === 0 ? "None" : childBlockRefs.map((ref) => `(${ref})`).join(" "),
      "Resume Instructions": "Resume after the block",
    },
  };
}

describe("compressTool", () => {
  test("declares exact non-read-only, non-destructive, serial traits", () => {
    expect(compressTool.name).toBe(TOOL_COMPRESS);
    expect(compressTool.traits).toEqual({ readOnly: false, destructive: false, concurrencySafe: false });
  });

  test("commits a valid dynamic range as compression.block_committed without mutating canonical messages", async () => {
    const store = makeStore();
    const beforeMessages = JSON.stringify(store.getState().messages);
    const registry = registryFixture.registry;

    const result = await registry.execute({
      toolCallId: "compress-call-1",
      toolName: TOOL_COMPRESS,
      input: { startId: "m0001", endId: "m0004", summary: summary() },
    }, makeCtx(store));

    const finalized = expectSettledResult(result);
    expect(finalized.isError).toBe(false);
    const output = JSON.parse(finalized.output.preview) as { ok: boolean; blockRef: string };
    expect(output).toMatchObject({ ok: true, blockRef: "b1" });
    expect(store.getState().compression?.activeBlockRefs).toEqual(["b1"]);
    expect(store.getState().events.at(-1)?.payload.type).toBe("compression.block_committed");
    expect(JSON.stringify(store.getState().messages)).toBe(beforeMessages);
  });

  test("rejects invalid ranges with structured output and no active coverage", async () => {
    const store = makeStore();
    const registry = registryFixture.registry;

    const result = await registry.execute({
      toolCallId: "compress-call-2",
      toolName: TOOL_COMPRESS,
      input: { startId: "msg-1", endId: "m0002", summary: summary() },
    }, makeCtx(store));

    const finalized = expectSettledResult(result);
    expect(finalized.isError).toBe(false);
    const output = JSON.parse(finalized.output.preview) as { ok: boolean; code: string };
    expect(output).toMatchObject({ ok: false, code: "range_rejected" });
    expect(store.getState().compression?.activeBlockRefs).toEqual([]);
    expect(store.getState().events.at(-1)?.payload.type).toBe("compression.block_failed");
  });

  test("rejects latest-tail ranges transactionally", async () => {
    const store = makeStore();
    const registry = registryFixture.registry;

    const result = await registry.execute({
      toolCallId: "compress-call-3",
      toolName: TOOL_COMPRESS,
      input: { startId: "m0005", endId: "m0006", summary: summary() },
    }, makeCtx(store));

    const finalized = expectSettledResult(result);
    expect(finalized.isError).toBe(false);
    const output = JSON.parse(finalized.output.preview) as { ok: boolean; code: string; protectedRefs?: { kind: string }[] };
    expect(output).toMatchObject({ ok: false, code: "protected_content" });
    expect(output.protectedRefs?.map((ref) => ref.kind)).toEqual(expect.arrayContaining(["latest_tail"]));
    expect(store.getState().compression?.activeBlockRefs).toEqual([]);
    expect(store.getState().events.at(-1)?.payload.type).toBe("compression.block_failed");
  });

  test("rejects unknown summary fields", async () => {
    const registry = registryFixture.registry;

    const result = await registry.execute({
      toolCallId: "compress-call-version",
      toolName: TOOL_COMPRESS,
      input: { startId: "m0001", endId: "m0004", summary: { ...summary(), unexpectedField: true } },
    }, makeCtx(makeStore()));

    expect(expectSettledResult(result).isError).toBe(true);
  });
});
