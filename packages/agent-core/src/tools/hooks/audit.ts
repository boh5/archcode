import type { FinalizedToolResult } from "@archcode/protocol";
import type { FinalizedResultHook, ToolExecutionContext } from "../types";
import { redactValue } from "../../security";

export interface AuditEvent {
  toolName: string;
  toolCallId: string;
  input: unknown;
  permissionOutcome?: "allow" | "deny" | "ask";
  durationMs?: number;
  status: "success" | "error";
  exitCode?: number | null;
  output: { completeness: "complete" | "partial"; storedBytes: number; omittedBytes: number; recovery: "none" | "source" | "artifact" };
}

export type AuditSink = (event: AuditEvent) => void | Promise<void>;

export interface AuditHookOptions {
  sink?: AuditSink;
}

export function createAuditHook(options: AuditHookOptions = {}): FinalizedResultHook {
  const sink = options.sink ?? (async () => {});

  return async function auditAfterHook(
    result: FinalizedToolResult,
    ctx: ToolExecutionContext,
  ): Promise<void> {
    const event: AuditEvent = {
      toolName: ctx.toolName,
      toolCallId: ctx.toolCallId,
      input: redactValue(ctx.redactedInput ?? ctx.input),
      ...(ctx.permissionOutcome ? { permissionOutcome: ctx.permissionOutcome } : {}),
      ...(ctx.durationMs !== undefined ? { durationMs: ctx.durationMs } : {}),
      status: result.isError ? "error" : "success",
      ...(result.details?.process ? { exitCode: result.details.process.exitCode } : {}),
      output: {
        completeness: result.output.completeness,
        storedBytes: result.output.stored.bytes,
        omittedBytes: result.output.omitted.bytes,
        recovery: result.output.recovery.kind,
      },
    };

    await sink(event);
  };
}
