import type { AfterHook, ToolExecutionContext, ToolExecutionResult } from "../types";
import { redactValue } from "./redact";

export interface AuditEvent {
  version: 1;
  toolName: string;
  toolCallId: string;
  input: unknown;
  permissionOutcome?: "allow" | "deny" | "ask";
  durationMs?: number;
  status: "success" | "error";
  exitCode?: number;
  truncation?: {
    truncated: boolean;
    fullOutputPath?: string;
  };
}

export type AuditSink = (event: AuditEvent) => void | Promise<void>;

export interface AuditHookOptions {
  sink?: AuditSink;
}

export function createAuditHook(options: AuditHookOptions = {}): AfterHook {
  const sink = options.sink ?? (async () => {});

  return async function auditAfterHook(
    result: ToolExecutionResult,
    ctx: ToolExecutionContext,
  ): Promise<void> {
    const event: AuditEvent = {
      version: 1,
      toolName: ctx.toolName,
      toolCallId: ctx.toolCallId,
      input: redactValue(ctx.redactedInput ?? ctx.input),
      ...(ctx.permissionOutcome ? { permissionOutcome: ctx.permissionOutcome } : {}),
      ...(ctx.durationMs !== undefined ? { durationMs: ctx.durationMs } : {}),
      status: result.isError ? "error" : "success",
      ...(typeof result.meta?.exitCode === "number" ? { exitCode: result.meta.exitCode } : {}),
      ...(result.meta?.truncated === true
        ? {
            truncation: {
              truncated: true,
              ...(typeof result.meta.fullOutputPath === "string"
                ? { fullOutputPath: result.meta.fullOutputPath }
                : {}),
            },
          }
        : {}),
    };

    await sink(event);
  };
}
