import { describe, expect, test } from "bun:test";
import type { ToolPart } from "@specra/protocol";
import { parseToolInput, parseToolOutput, mapDelegationStatus } from "./ChatMessages";

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

  test("error maps to pending", () => {
    expect(mapDelegationStatus("error")).toBe("pending");
  });

  test("all ToolPart states are covered", () => {
    const states: ToolPart["state"][] = ["pending", "running", "completed", "error"];
    for (const state of states) {
      const result = mapDelegationStatus(state);
      expect(typeof result).toBe("string");
      expect(["running", "completed", "pending"]).toContain(result);
    }
  });
});