import { describe, expect, it } from "bun:test";
import { storeManager } from "../../store/store";
import type { ToolExecutionContext } from "../types";
import { REDACTION_MARKER } from "../security";
import { createRedactionHook } from "./redact";
import { createTestProjectContext } from "../test-project-context";

const RAW_SECRET = "sk_test_1234567890abcdef";

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return { store: {} as ToolExecutionContext["store"],
  toolName: "bash",
  toolCallId: "call-1",
  input: { command: `curl -H Authorization=${RAW_SECRET}` },
  step: 0,
  abort: new AbortController().signal,
  startedAt: Date.now(),
  allowedTools: new Set<string>(),
  cwd: "/tmp",
  storeManager,
    projectContext: createTestProjectContext("/tmp"), ...overrides,  };
}

describe("redaction hook", () => {
  it("redacts output, meta, and context redacted input", async () => {
    const hook = createRedactionHook();
    const ctx = makeCtx();

    const result = await hook(
      {
        output: `stdout ${RAW_SECRET}\nstderr password=${RAW_SECRET}`,
        isError: true,
        meta: { token: RAW_SECRET, detail: `error ${RAW_SECRET}` },
      },
      ctx,
    );

    expect(result).toEqual({
      output: `stdout ${REDACTION_MARKER}\nstderr password=${REDACTION_MARKER}`,
      isError: true,
      meta: { token: REDACTION_MARKER, detail: `error ${REDACTION_MARKER}` },
    });
    expect(ctx.redactedInput).toEqual({ command: `curl -H Authorization=${REDACTION_MARKER}` });
    expect(JSON.stringify(result)).not.toContain(RAW_SECRET);
    expect(JSON.stringify(ctx.redactedInput)).not.toContain(RAW_SECRET);
  });
});
