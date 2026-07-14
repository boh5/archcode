import { describe, expect, test } from "bun:test";
import { DCP_PARITY_ITEMS } from "./constants";
import { DCP_PARITY_CHECKLIST, isDcpParityContractComplete } from "./parity";
import type { DcpParityItem } from "./types";

interface ExecutableTestMapping {
  readonly file: string;
  readonly testName: string;
  readonly anchors: readonly string[];
}

const EXECUTABLE_DCP_PARITY_COVERAGE = {
  stable_session_local_message_refs: [
    {
      file: "packages/agent-core/src/compression/refs.test.ts",
      testName: "refs are stable m0001 and b1 without mutating canonical ids",
      anchors: ["expect(firstMessage.ref).toBe(\"m0001\")", "expect(repeatedMessage.ref).toBe(\"m0001\")"],
    },
    {
      file: "packages/agent-core/src/store/projection.test.ts",
      testName: "fresh compression state injects projection refs for uncompressed messages",
      anchors: ["m0001", "m0002"],
    },
  ],
  stable_session_local_block_refs: [
    {
      file: "packages/agent-core/src/compression/refs.test.ts",
      testName: "refs are stable m0001 and b1 without mutating canonical ids",
      anchors: ["expect(firstBlock.ref).toBe(\"b1\")", "expect(repeatedBlock.ref).toBe(\"b1\")"],
    },
  ],
  range_compression_by_start_end_ref: [
    {
      file: "packages/agent-core/src/compression/dynamic-range.test.ts",
      testName: "valid model-authored range commits an active block without mutating transcript messages",
      anchors: ["startId: \"m0001\"", "endId: \"m0004\"", "compression.block_committed"],
    },
  ],
  model_callable_compress_contract: [
    {
      file: "packages/agent-core/src/tools/builtins/compress.test.ts",
      testName: "declares exact non-read-only, non-destructive, serial traits",
      anchors: ["TOOL_COMPRESS", "concurrencySafe: false"],
    },
    {
      file: "packages/agent-core/src/tools/builtins/compress.test.ts",
      testName: "commits a valid dynamic range as compression.block_committed without mutating canonical messages",
      anchors: ["startId: \"m0001\"", "endId: \"m0004\"", "summary: summary()"],
    },
  ],
  nested_blocks_with_placeholder_validation: [
    {
      file: "packages/agent-core/src/compression/summary.test.ts",
      testName: "summary requires child placeholders exactly once",
      anchors: ["validateCompressionSummary(summary, [\"b1\"]).ok", "Resume Instructions"],
    },
    {
      file: "packages/agent-core/src/compression/dynamic-range.test.ts",
      testName: "nested parent requires child placeholder exactly once and supersedes the child",
      anchors: ["summary([\"b1\"])", "supersededBy"],
    },
  ],
  active_inactive_superseded_lifecycle: [
    {
      file: "packages/agent-core/src/compression/state.test.ts",
      testName: "nested parent allows whole-child nesting and preserves superseded child resolvability",
      anchors: ["status).toBe(\"superseded\")", "activeBlockRefs).toEqual([\"b2\"])"],
    },
  ],
  protected_content_contracts: [
    {
      file: "packages/agent-core/src/compression/dynamic-range.test.ts",
      testName: "rejects ranges that include the latest transcript tail",
      anchors: ["latest_tail", "protected_content"],
    },
    {
      file: "packages/agent-core/src/compression/dynamic-range.test.ts",
      testName: "protects pending and running tools, unknown results, protect tags, child links, todos, and reminders",
      anchors: ["pending_tool", "running_tool", "unknown_result", "subagent_link", "todo", "reminder"],
    },
  ],
  user_messages_preserve_canonical_originals: [
    {
      file: "packages/agent-core/src/compression/dynamic-range.test.ts",
      testName: "valid model-authored range commits an active block without mutating transcript messages",
      anchors: ["originalMessages", "JSON.stringify(state.messages)"],
    },
    {
      file: "packages/agent-core/src/store/projection.test.ts",
      testName: "projection-only refs replace active ranges without mutating canonical text",
      anchors: ["not.toContain(\"ORIGINAL_OLD_USER\")", "toBe(originalText)"],
    },
  ],
  typed_tool_output_deduplication_contract: [
    {
      file: "packages/agent-core/src/compression/dynamic-range.test.ts",
      testName: "deduplicates repeated completed outputs and purges repeated old errors",
      anchors: ["deduplicatedToolOutputs", "count).toBe(2)"],
    },
  ],
  typed_purge_error_contract: [
    {
      file: "packages/agent-core/src/compression/dynamic-range.test.ts",
      testName: "deduplicates repeated completed outputs and purges repeated old errors",
      anchors: ["purgedErrors", "collapsedRefs"],
    },
    {
      file: "packages/agent-core/src/compression/dynamic-range.test.ts",
      testName: "purge analysis preserves unknownResult errors instead of collapsing them",
      anchors: ["unknownResultRefs", "m0003"],
    },
  ],
  soft_and_strong_nudges: [
    {
      file: "packages/agent-core/src/agents/query/hooks/hybrid-compression.test.ts",
      testName: "injects no nudge at 54%, soft nudge at exactly 55%, and strong nudge at exactly 70%",
      anchors: ["soft nudge", "strong nudge"],
    },
  ],
  hard_compact_safety_boundary: [
    {
      file: "packages/agent-core/src/agents/query/hooks/hybrid-compression.test.ts",
      testName: "runs forced hard compact at exactly 85% when a safe range exists",
      anchors: ["state.events.at(-1)?.payload.type).toBe(\"compact\")", "compression.block_committed"],
    },
  ],
  manual_compact_entry_contract: [
    {
      file: "packages/agent-core/src/commands/compact.test.ts",
      testName: "manual compact emits compact event and compaction part without compression block",
      anchors: ["CompactionPart", "events.at(-1)?.payload.type).toBe(\"compact\")", "compression.block_committed"],
    },
  ],
  ui_expandable_original_range_contract: [
    {
      file: "apps/server/src/routes/compression.test.ts",
      testName: "GET original range returns covered ids and canonical messages",
      anchors: ["coveredRefs", "coveredMessageIds", "body.messages"],
    },
    {
      file: "apps/web/src/components/composite/ChatMessages.test.tsx",
      testName: "fetches original range only after clicking Show original range (expand)",
      anchors: ["Show original range", "toHaveBeenCalledTimes(0)", "toHaveBeenCalledTimes(1)"],
    },
  ],
} as const satisfies Record<DcpParityItem, readonly ExecutableTestMapping[]>;

const executableCoverage: Record<DcpParityItem, readonly ExecutableTestMapping[]> = EXECUTABLE_DCP_PARITY_COVERAGE;
const repoRoot = new URL("../../../../", import.meta.url);

describe("DCP executable parity coverage", () => {
  test("maps every contract checklist item to non-empty executable coverage", () => {
    expect(isDcpParityContractComplete()).toBe(true);
    expect([...DCP_PARITY_CHECKLIST].sort()).toEqual([...DCP_PARITY_ITEMS].sort());

    const mappedItems = Object.keys(executableCoverage).sort();
    expect(mappedItems).toEqual([...DCP_PARITY_ITEMS].sort());

    const missingCoverage = DCP_PARITY_ITEMS.filter((item) => executableCoverage[item].length === 0);
    expect(missingCoverage).toEqual([]);
  });

  test("mapped files contain the named tests and assertion anchors", async () => {
    for (const item of DCP_PARITY_ITEMS) {
      for (const mapping of executableCoverage[item]) {
        const source = await Bun.file(new URL(mapping.file, repoRoot)).text();

        expect(source, `${item} should map to executable test ${mapping.testName}`).toContain(`test(${JSON.stringify(mapping.testName)}`);

        for (const anchor of mapping.anchors) {
          expect(source, `${item} mapping ${mapping.testName} should include ${anchor}`).toContain(anchor);
        }
      }
    }
  });
});
