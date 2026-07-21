import { describe, expect, test } from "bun:test";
import { DelegationRequestSchema } from "./schema";

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent_type: "build",
    profile: "deep",
    title: "Implement parser",
    objective: "Implement and verify the parser change.",
    skills: ["safe-refactor"],
    background: false,
    ...overrides,
  };
}

describe("DelegationRequestSchema", () => {
  test("accepts only the six-field hard-cut contract", () => {
    expect(DelegationRequestSchema.safeParse(request()).success).toBe(true);
    expect(() => DelegationRequestSchema.parse(request({ owned_scope: [] }))).toThrow();
    expect(() => DelegationRequestSchema.parse(request({ write_scope: [] }))).toThrow();
    expect(() => DelegationRequestSchema.parse(request({ profile: undefined }))).toThrow();
    expect(() => DelegationRequestSchema.parse(request({ skills: undefined }))).toThrow();
  });

  test("rejects removed and non-runnable Agent identities", () => {
    for (const agent_type of ["lead", "engineer", "plan", "reviewer", "shaper", "visual"]) {
      expect(() => DelegationRequestSchema.parse(request({ agent_type }))).toThrow();
    }
  });

  test("enforces the target Profile matrix before child creation", () => {
    expect(DelegationRequestSchema.parse(request({ agent_type: "analyst", profile: "deep" })).profile).toBe("deep");
    expect(() => DelegationRequestSchema.parse(request({ agent_type: "analyst", profile: "fast" }))).toThrow();
    expect(DelegationRequestSchema.parse(request({ agent_type: "build", profile: "fast" })).profile).toBe("fast");
    expect(DelegationRequestSchema.parse(request({ agent_type: "build", profile: "deep" })).profile).toBe("deep");
    for (const agent_type of ["explore", "librarian"]) {
      expect(DelegationRequestSchema.parse(request({ agent_type, profile: "fast" })).profile).toBe("fast");
      expect(() => DelegationRequestSchema.parse(request({ agent_type, profile: "deep" }))).toThrow();
    }
    expect(() => DelegationRequestSchema.parse(request({ profile: "principal" }))).toThrow();
    expect(() => DelegationRequestSchema.parse(request({ profile: "visual" }))).toThrow();
  });

  test("keeps objective, title, and Skill names strict and non-empty", () => {
    expect(() => DelegationRequestSchema.parse(request({ title: " " }))).toThrow();
    expect(() => DelegationRequestSchema.parse(request({ objective: "" }))).toThrow();
    expect(() => DelegationRequestSchema.parse(request({ skills: ["Bad Skill"] }))).toThrow();
    expect(() => DelegationRequestSchema.parse(request({ background: "false" }))).toThrow();
  });
});
