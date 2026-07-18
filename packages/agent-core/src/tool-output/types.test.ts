import { describe, expect, test } from "bun:test";
import type {
  RawToolResult,
  RegistryExecutionOutcome,
  ToolBlockedRequest,
  ToolOutputPolicy,
} from "./types";

describe("tool output contracts", () => {
  test("keeps raw drafts and runtime sidecars outside the finalized result", () => {
    const raw = {
      isError: false,
      draft: { kind: "text", text: "changed cwd" },
      sidecar: { sessionCwdChanged: true },
    } satisfies RawToolResult;
    const settled = {
      kind: "settled",
      result: {
        isError: false,
        output: {
          preview: raw.draft.text,
          completeness: "complete",
          observed: { bytes: 11, lines: 1 },
          canonical: { bytes: 11, lines: 1 },
          stored: { bytes: 11, lines: 1 },
          omitted: { bytes: 0, lines: 0 },
          recovery: { kind: "none" },
        },
      },
      sidecar: raw.sidecar,
    } satisfies RegistryExecutionOutcome;

    expect(settled.result).not.toHaveProperty("sidecar");
    expect(settled.sidecar).toEqual({ sessionCwdChanged: true });
  });

  test("uses strict discriminants for policies and blockers", () => {
    const policies = [
      { kind: "source", previewDirection: "head" },
      { kind: "artifact", previewDirection: "head-tail" },
      { kind: "inline", previewDirection: "head" },
    ] satisfies ToolOutputPolicy[];
    const blocked = {
      source: { type: "tool_permission", toolCallId: "call-1", toolName: "bash" },
      displayPayload: { title: "Approve", redacted: true },
      permissionFingerprint: "a".repeat(64),
      persistentApprovalEligible: false,
      permission: { description: "Run command" },
    } satisfies ToolBlockedRequest;

    expect(policies.map((policy) => policy.kind)).toEqual(["source", "artifact", "inline"]);
    expect(blocked.source.type).toBe("tool_permission");
  });
});
