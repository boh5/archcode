import { describe, expect, test } from "bun:test";
import type { ToolPart } from "@specra/protocol";
import { parseToolInput, parseToolOutput, mapDelegationStatus, parseDelegateMetadata, mapDelegateRunStatus } from "./ChatMessages";

// ─── parseToolInput ───

describe("parseToolInput", () => {
  test("parses object input directly", () => {
    const result = parseToolInput({ agent_type: "explore", prompt: "test" });
    expect(result).toEqual({ agent_type: "explore", prompt: "test" });
  });

  test("parses string JSON input", () => {
    const result = parseToolInput(JSON.stringify({ agent_type: "explore", description: "Search" }));
    expect(result).toEqual({ agent_type: "explore", description: "Search" });
  });

  test("returns null for null input", () => {
    expect(parseToolInput(null)).toBeNull();
  });

  test("returns null for undefined input", () => {
    expect(parseToolInput(undefined)).toBeNull();
  });

  test("returns null for invalid JSON string", () => {
    expect(parseToolInput("not json")).toBeNull();
  });

  test("returns null for number input", () => {
    expect(parseToolInput(42)).toBeNull();
  });
});

// ─── parseToolOutput ───

describe("parseToolOutput", () => {
  test("parses valid JSON output", () => {
    const result = parseToolOutput(JSON.stringify({ sessionId: "abc-123", text: "Done" }));
    expect(result).toEqual({ sessionId: "abc-123", text: "Done" });
  });

  test("returns null for undefined output", () => {
    expect(parseToolOutput(undefined)).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(parseToolOutput("not json")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseToolOutput("")).toBeNull();
  });
});

// ─── mapDelegationStatus ───

describe("mapDelegationStatus", () => {
  test("completed maps to completed", () => {
    expect(mapDelegationStatus("completed")).toBe("completed");
  });

  test("running maps to running", () => {
    expect(mapDelegationStatus("running")).toBe("running");
  });

  test("pending maps to running", () => {
    expect(mapDelegationStatus("pending")).toBe("running");
  });

  test("error maps to error", () => {
    expect(mapDelegationStatus("error")).toBe("error");
  });

  test("all ToolPart states are covered", () => {
    const states: ToolPart["state"][] = ["pending", "running", "completed", "error"];
    for (const state of states) {
      const result = mapDelegationStatus(state);
      expect(typeof result).toBe("string");
      expect(["running", "completed", "error"]).toContain(result);
    }
  });
});

// ─── parseDelegateMetadata ───

describe("parseDelegateMetadata", () => {
  const sampleOutput = [
    "Sub-agent completed.",
    "Agent type: explorer",
    "Session ID: abc-123-def",
    "Status: completed",
    "Duration: 5000ms",
    "Result:",
    "  Some result text",
    "",
    "<delegate_metadata>",
    'session_id: "abc-123-def"',
    'parent_session_id: "parent-456"',
    'agent_type: "explorer"',
    'description: "Search for X"',
    "status: completed",
    "background: false",
    "started_at: 1234567890",
    "ended_at: 1234567895",
    "duration_ms: 5000",
    "</delegate_metadata>",
  ].join("\n");

  test("extracts sessionId and status from delegate metadata", () => {
    const result = parseDelegateMetadata(sampleOutput);
    expect(result).toEqual({
      sessionId: "abc-123-def",
      status: "completed",
    });
  });

  test("returns null when no metadata block exists", () => {
    expect(parseDelegateMetadata("plain text without metadata")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseDelegateMetadata("")).toBeNull();
  });

  test("extracts sessionId without quotes", () => {
    const output = [
      "<delegate_metadata>",
      "session_id: no-quotes-uuid",
      "status: completed",
      "</delegate_metadata>",
    ].join("\n");
    const result = parseDelegateMetadata(output);
    expect(result?.sessionId).toBe("no-quotes-uuid");
  });

  test("extracts error status from metadata", () => {
    const output = [
      "<delegate_metadata>",
      'session_id: "abc-123"',
      "status: timed_out",
      "</delegate_metadata>",
    ].join("\n");
    const result = parseDelegateMetadata(output);
    expect(result?.status).toBe("timed_out");
  });
});

// ─── mapDelegateRunStatus ───

describe("mapDelegateRunStatus", () => {
  test("completed maps to completed", () => {
    expect(mapDelegateRunStatus("completed")).toBe("completed");
  });

  test("running maps to running", () => {
    expect(mapDelegateRunStatus("running")).toBe("running");
  });

  test("timed_out maps to error", () => {
    expect(mapDelegateRunStatus("timed_out")).toBe("error");
  });

  test("aborted maps to error", () => {
    expect(mapDelegateRunStatus("aborted")).toBe("error");
  });

  test("cancelled maps to error", () => {
    expect(mapDelegateRunStatus("cancelled")).toBe("error");
  });

  test("max_steps maps to error", () => {
    expect(mapDelegateRunStatus("max_steps")).toBe("error");
  });

  test("failed maps to error", () => {
    expect(mapDelegateRunStatus("failed")).toBe("error");
  });
});