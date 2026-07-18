import { ApiError, apiFetch } from "./client";

export type ToolOutputCompleteness = "complete" | "partial";
export type ToolOutputSegment = "full" | "head" | "tail";

export interface ToolOutputReadRecord {
  readonly segment: ToolOutputSegment;
  readonly canonicalStart: number;
  readonly canonicalEnd: number;
  readonly text: string;
  readonly continuedFromPrevious: boolean;
  readonly continuesNext: boolean;
}

export interface ToolOutputReadPage {
  readonly outputRef: string;
  readonly completeness: ToolOutputCompleteness;
  readonly records: readonly ToolOutputReadRecord[];
  readonly nextCursor?: string;
  readonly gap?: {
    readonly canonicalStart: number;
    readonly canonicalEnd: number;
  };
}

export interface ToolOutputSearchMatch {
  readonly outputRef: string;
  readonly segment: ToolOutputSegment;
  readonly canonicalStart: number;
  readonly canonicalEnd: number;
  readonly snippet: string;
}

export interface ToolOutputSearchPage {
  readonly outputRef?: string;
  readonly matches: readonly ToolOutputSearchMatch[];
  readonly nextCursor?: string;
  readonly searchCompleteness: "complete" | "partial_artifact";
}

export type ToolOutputErrorCode =
  | "TOOL_OUTPUT_FORBIDDEN"
  | "TOOL_OUTPUT_NOT_FOUND"
  | "TOOL_OUTPUT_EXPIRED"
  | "TOOL_OUTPUT_EVICTED"
  | "TOOL_OUTPUT_UNAVAILABLE"
  | "TOOL_OUTPUT_INVALID_CURSOR"
  | "TOOL_OUTPUT_INVALID_PATTERN"
  | "TOOL_OUTPUT_SEARCH_TIMEOUT"
  | "TOOL_OUTPUT_POLICY_VIOLATION";

export function classifyToolOutputError(error: unknown): ToolOutputErrorCode | undefined {
  if (!(error instanceof ApiError)) return undefined;
  switch (error.code) {
    case "TOOL_OUTPUT_FORBIDDEN":
    case "TOOL_OUTPUT_NOT_FOUND":
    case "TOOL_OUTPUT_EXPIRED":
    case "TOOL_OUTPUT_EVICTED":
    case "TOOL_OUTPUT_UNAVAILABLE":
    case "TOOL_OUTPUT_INVALID_CURSOR":
    case "TOOL_OUTPUT_INVALID_PATTERN":
    case "TOOL_OUTPUT_SEARCH_TIMEOUT":
    case "TOOL_OUTPUT_POLICY_VIOLATION":
      return error.code;
    default:
      return undefined;
  }
}

export function isTerminalToolOutputError(error: unknown): boolean {
  const code = classifyToolOutputError(error);
  return code === "TOOL_OUTPUT_EXPIRED"
    || code === "TOOL_OUTPUT_EVICTED"
    || code === "TOOL_OUTPUT_NOT_FOUND";
}

export async function readToolOutput(input: {
  readonly projectSlug: string;
  readonly sessionId: string;
  readonly outputRef: string;
  readonly cursor?: string;
  readonly limit?: number;
}): Promise<ToolOutputReadPage> {
  const query = new URLSearchParams();
  if (input.cursor) query.set("cursor", input.cursor);
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return apiFetch<ToolOutputReadPage>(
    `/api/projects/${encodeURIComponent(input.projectSlug)}/sessions/${encodeURIComponent(input.sessionId)}/tool-outputs/${encodeURIComponent(input.outputRef)}${suffix}`,
  );
}

export async function searchToolOutput(input: {
  readonly projectSlug: string;
  readonly sessionId: string;
  readonly outputRef: string;
  readonly pattern: string;
  readonly cursor?: string;
  readonly limit?: number;
}): Promise<ToolOutputSearchPage> {
  return apiFetch<ToolOutputSearchPage>(
    `/api/projects/${encodeURIComponent(input.projectSlug)}/sessions/${encodeURIComponent(input.sessionId)}/tool-outputs/search`,
    {
      method: "POST",
      body: {
        outputRef: input.outputRef,
        pattern: input.pattern,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
    },
  );
}
