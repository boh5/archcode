import type { JsonObject, ToolResultDetails } from "@archcode/protocol";
import type { RawToolResult, ToolExecutionSidecar } from "./types";

export interface TextToolResultOptions {
  readonly isError?: boolean;
  readonly details?: ToolResultDetails;
  readonly sidecar?: ToolExecutionSidecar;
}

/** Construct a raw text draft. Only ToolRegistry may turn it into a persisted result. */
export function createTextToolResult(
  text: string,
  options: TextToolResultOptions = {},
): RawToolResult {
  return {
    isError: options.isError ?? false,
    draft: { kind: "text", text },
    ...(options.details === undefined ? {} : { details: options.details }),
    ...(options.sidecar === undefined ? {} : { sidecar: options.sidecar }),
  };
}

export function createSourceToolResult(
  text: string,
  nextInput?: JsonObject,
): RawToolResult {
  return {
    isError: false,
    draft: {
      kind: "source",
      text,
      ...(nextInput === undefined ? {} : { nextInput }),
    },
  };
}
