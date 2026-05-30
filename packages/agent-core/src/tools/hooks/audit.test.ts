import { describe, expect, it } from "bun:test";
import { storeManager } from "../../store/store";
import type { ToolExecutionContext } from "../types";
import { createAuditHook, type AuditEvent } from "./audit";
import { REDACTION_MARKER } from "../security";
import { createTestProjectContext } from "../test-project-context";

const RAW_SECRET = "sk_test_1234567890abcdef";

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return { store: {} as ToolExecutionContext["store"],
  toolName: "bash",
  toolCallId: "call-1",
  input: { command: `echo ${RAW_SECRET}`, token: RAW_SECRET },
  redactedInput: { command: `echo ${REDACTION_MARKER}`, token: REDACTION_MARKER },
  permissionOutcome: "ask",
  step: 0,
  abort: new AbortController().signal,
  startedAt: Date.now(),
  durationMs: 25,
  allowedTools: new Set<string>(),
  workspaceRoot: "/tmp",
  storeManager,
    projectContext: createTestProjectContext("/tmp"), ...overrides,  };
}

describe("createAuditHook", () => {
  it("emits minimal redacted structured metadata without raw output", async () => {
    const events: AuditEvent[] = [];
    const auditSink = (event: AuditEvent): void => { events.push(event); };
    const hook = createAuditHook({ sink: auditSink });

    await hook(
      {
        output: `raw output ${RAW_SECRET}`,
        isError: false,
        meta: { exitCode: 7, truncated: true, fullOutputPath: "/tmp/full.txt" },
      },
      makeCtx(),
    );

    expect(events).toEqual([
      {
        version: 1,
        toolName: "bash",
        toolCallId: "call-1",
        input: { command: `echo ${REDACTION_MARKER}`, token: REDACTION_MARKER },
        permissionOutcome: "ask",
        durationMs: 25,
        status: "success",
        exitCode: 7,
        truncation: { truncated: true, fullOutputPath: "/tmp/full.txt" },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(RAW_SECRET);
    expect(JSON.stringify(events)).not.toContain("raw output");
  });
});
