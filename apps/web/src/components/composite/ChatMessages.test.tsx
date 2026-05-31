import { describe, expect, test } from "bun:test";
import type { ToolChildSessionLinkStatus } from "@specra/protocol";
import { parseToolInput, parseToolOutput, mapLinkStatusToBadge } from "./ChatMessages";

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

// ─── mapLinkStatusToBadge ───

describe("mapLinkStatusToBadge", () => {
  test("completed maps to completed", () => {
    expect(mapLinkStatusToBadge("completed")).toBe("completed");
  });

  test("running maps to running", () => {
    expect(mapLinkStatusToBadge("running")).toBe("running");
  });

  test("linked maps to running", () => {
    expect(mapLinkStatusToBadge("linked")).toBe("running");
  });

  test("cancelling maps to running", () => {
    expect(mapLinkStatusToBadge("cancelling")).toBe("running");
  });

  test("failed maps to error", () => {
    expect(mapLinkStatusToBadge("failed")).toBe("error");
  });

  test("timed_out maps to error", () => {
    expect(mapLinkStatusToBadge("timed_out")).toBe("error");
  });

  test("cancelled maps to error", () => {
    expect(mapLinkStatusToBadge("cancelled")).toBe("error");
  });

  test("interrupted maps to error", () => {
    expect(mapLinkStatusToBadge("interrupted")).toBe("error");
  });

  test("all ToolChildSessionLinkStatus values are covered", () => {
    const statuses: ToolChildSessionLinkStatus[] = [
      "linked", "running", "cancelling", "completed", "failed", "timed_out", "cancelled", "interrupted",
    ];
    for (const status of statuses) {
      const result = mapLinkStatusToBadge(status);
      expect(typeof result).toBe("string");
      expect(["running", "completed", "error"]).toContain(result);
    }
  });
});