import { describe, expect, it } from "bun:test";
import { storeManager } from "../../store/store";
import type { ToolExecutionContext } from "../types";
import { createAuditHook, type AuditEvent } from "./audit";
import { createTestProjectContext } from "../test-project-context";
import type { FinalizedToolResult } from "@archcode/protocol";

const RAW_SECRET = "sk_test_1234567890abcdef";

function finalizedResult(preview: string): FinalizedToolResult {
  return {
    isError: false,
    output: {
      preview,
      completeness: "partial",
      observed: { bytes: 17, lines: 1 },
      canonical: { bytes: 17, lines: 1 },
      stored: { bytes: 7, lines: 1 },
      omitted: { bytes: 10, lines: 0 },
      recovery: { kind: "artifact", outputRef: "output_ref_1234567890", expiresAt: Number.MAX_SAFE_INTEGER, canRead: true, canSearch: true },
    },
    details: { process: { exitCode: 7, signal: null, timedOut: false, aborted: false, durationMs: 25 } },
  };
}

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return { store: {} as ToolExecutionContext["store"],
  toolName: "bash",
  toolCallId: "call-1",
  input: { command: `echo ${RAW_SECRET}`, token: RAW_SECRET },
  permissionOutcome: "ask",
  step: 0,
    executionId: "test-execution",
    runOrdinal: 0,
    toolBatchId: "test-tool-batch",
  abort: new AbortController().signal,
  startedAt: Date.now(),
  durationMs: 25,
  allowedTools: new Set<string>(),
  cwd: "/tmp",
  storeManager,
    projectContext: createTestProjectContext("/tmp"), ...overrides,  };
}

describe("createAuditHook", () => {
  it("emits execution input and minimal result metadata without tool output", async () => {
    const events: AuditEvent[] = [];
    const auditSink = (event: AuditEvent): void => { events.push(event); };
    const hook = createAuditHook({ sink: auditSink });

    await hook(
      finalizedResult(`raw output ${RAW_SECRET}`),
      makeCtx(),
    );

    expect(events).toEqual([
      {
        toolName: "bash",
        toolCallId: "call-1",
        input: { command: `echo ${RAW_SECRET}`, token: RAW_SECRET },
        permissionOutcome: "ask",
        durationMs: 25,
        status: "success",
        exitCode: 7,
        output: { completeness: "partial", storedBytes: 7, omittedBytes: 10, recovery: "artifact" },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("raw output");
  });
});
