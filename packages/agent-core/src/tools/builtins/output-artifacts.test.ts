import { describe, expect, mock, test } from "bun:test";

import { ToolOutputError } from "../../tool-output/errors";
import { storeManager } from "../../store/store";
import { createTestProjectContext } from "../test-project-context";
import type { ToolOutputAccessService } from "../../tool-output/access-service";
import type { ToolExecutionContext } from "../types";
import { OutputReadInputSchema, OutputSearchInputSchema, outputReadTool, outputSearchTool } from "./output-artifacts";
import { sourceDraftText } from "./source-page";

function ctx(outputArtifacts?: ToolOutputAccessService): ToolExecutionContext {
  return {
    store: {} as any, storeManager, toolName: "output_read", toolCallId: "call", input: {}, step: 1,
    abort: new AbortController().signal, startedAt: Date.now(), allowedTools: new Set(["output_read", "output_search"]),
    cwd: "/workspace", projectContext: createTestProjectContext("/workspace"), outputArtifacts,
  };
}

describe("tool output recovery descriptors", () => {
  test("output_read returns a source page and schema-valid opaque continuation", async () => {
    let readInput: Parameters<ToolOutputAccessService["read"]>[0] | undefined;
    const service = {
      countRecoverable: mock(async () => 1),
      read: mock(async (input: Parameters<ToolOutputAccessService["read"]>[0]) => {
        readInput = input;
        return {
          outputRef: "ref" as any, completeness: "complete" as const,
          records: [{ segment: "full" as const, canonicalStart: 0, canonicalEnd: 8, text: "sentinel", continuedFromPrevious: false, continuesNext: false }],
          nextCursor: "opaque-next",
        };
      }),
      search: mock(async () => { throw new Error("unused"); }),
    } satisfies ToolOutputAccessService;

    const result = await outputReadTool.execute({ outputRef: "ref", limit: 200 }, ctx(service));
    expect(sourceDraftText(result)).toContain("completeness=complete gap=none records=1");
    expect(sourceDraftText(result)).toContain("segment=full range=0-8");
    expect(sourceDraftText(result)).toContain("sentinel");
    expect(readInput).toMatchObject({
      limit: 32,
      maxContentBytes: 42 * 1024,
    });
    if (result.draft.kind !== "source" || result.draft.nextInput === undefined) throw new Error("Expected recovery");
    expect(OutputReadInputSchema.safeParse(result.draft.nextInput).success).toBe(true);
    expect(result.draft.nextInput.cursor).toBe("opaque-next");
  });

  test("output_search supports family search and preserves ref-bearing matches", async () => {
    const service = {
      countRecoverable: mock(async () => 1),
      read: mock(async () => { throw new Error("unused"); }),
      search: mock(async () => ({
        matches: [{ outputRef: "family-ref" as any, segment: "full" as const, canonicalStart: 10, canonicalEnd: 13, snippet: "hit" }],
        searchCompleteness: "complete" as const,
      })),
    } satisfies ToolOutputAccessService;

    const result = await outputSearchTool.execute({ pattern: "hit", limit: 50 }, ctx(service));
    expect(sourceDraftText(result)).toContain("scope=family searchCompleteness=complete matches=1");
    expect(sourceDraftText(result)).toContain("outputRef=family-ref segment=full range=10-13");
    expect(sourceDraftText(result)).toContain("hit");
    expect(result.draft.kind === "source" && result.draft.nextInput).toBeUndefined();
  });

  test("fails closed without an accessor and preserves stable store errors", async () => {
    const unavailable = await outputReadTool.execute({ outputRef: "ref", limit: 200 }, ctx());
    expect(unavailable.details?.error?.code).toBe("TOOL_OUTPUT_UNAVAILABLE");

    const service = {
      countRecoverable: mock(async () => 1),
      read: mock(async () => { throw new ToolOutputError("TOOL_OUTPUT_EXPIRED"); }),
      search: mock(async () => { throw new Error("unused"); }),
    } satisfies ToolOutputAccessService;
    const expired = await outputReadTool.execute({ outputRef: "ref", limit: 200 }, ctx(service));
    expect(expired.details?.error?.code).toBe("TOOL_OUTPUT_EXPIRED");
  });

  test("makes partial gaps and empty partial searches explicit", async () => {
    const service = {
      countRecoverable: mock(async () => 1),
      read: mock(async () => ({
        outputRef: "partial-ref" as any,
        completeness: "partial" as const,
        records: [
          { segment: "head" as const, canonicalStart: 0, canonicalEnd: 4, text: "HEAD", continuedFromPrevious: false, continuesNext: false },
          { segment: "tail" as const, canonicalStart: 100, canonicalEnd: 104, text: "TAIL", continuedFromPrevious: true, continuesNext: false },
        ],
        gap: { canonicalStart: 4, canonicalEnd: 100 },
      })),
      search: mock(async () => ({
        matches: [],
        searchCompleteness: "partial_artifact" as const,
      })),
    } satisfies ToolOutputAccessService;

    const read = await outputReadTool.execute({ outputRef: "partial-ref", limit: 200 }, ctx(service));
    const readText = sourceDraftText(read);
    expect(readText).toContain("completeness=partial gap=4-100");
    expect(readText).toContain("segment=head range=0-4");
    expect(readText).toContain("segment=tail range=100-104");

    const search = await outputSearchTool.execute({ outputRef: "partial-ref", pattern: "missing", limit: 50 }, ctx(service));
    expect(sourceDraftText(search)).toBe(
      "[search scope=partial-ref searchCompleteness=partial_artifact matches=0]\n",
    );
  });

  test("locks strict read/search input caps", () => {
    expect(OutputReadInputSchema.safeParse({ outputRef: "ref", limit: 1_001 }).success).toBe(false);
    expect(OutputSearchInputSchema.safeParse({ pattern: "x", limit: 101 }).success).toBe(false);
    expect(OutputSearchInputSchema.safeParse({ pattern: "你".repeat(400) }).success).toBe(false);
    expect(OutputSearchInputSchema.safeParse({ pattern: "x", unknown: true }).success).toBe(false);
  });
});
