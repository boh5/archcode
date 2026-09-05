import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import {
  MAX_DELEGATED_SESSION_TITLE_LENGTH,
} from "@archcode/protocol";
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
  test("accepts only the six required fields", () => {
    expect(DelegationRequestSchema.safeParse(request()).success).toBe(true);
    expect(() => DelegationRequestSchema.parse(request({ unexpectedField: true }))).toThrow();
    expect(() => DelegationRequestSchema.parse(request({ profile: undefined }))).toThrow();
    expect(() => DelegationRequestSchema.parse(request({ skills: undefined }))).toThrow();
  });

  test("accepts exactly the runnable child Agent identities", () => {
    for (const [agent_type, profile] of [
      ["analyst", "deep"],
      ["build", "deep"],
      ["explore", "fast"],
      ["librarian", "fast"],
    ] as const) {
      expect(DelegationRequestSchema.parse(request({ agent_type, profile })).agent_type).toBe(agent_type);
    }
    for (const agent_type of ["lead", "discussion", "unknown"]) {
      expect(() => DelegationRequestSchema.parse(request({ agent_type, profile: "deep" }))).toThrow();
    }
  });

  test("accepts the static delegated Profile domain without owning target authorization", () => {
    expect(DelegationRequestSchema.parse(request({ agent_type: "analyst", profile: "deep" })).profile).toBe("deep");
    expect(DelegationRequestSchema.parse(request({ agent_type: "analyst", profile: "fast" })).profile).toBe("fast");
    expect(DelegationRequestSchema.parse(request({ agent_type: "build", profile: "fast" })).profile).toBe("fast");
    expect(DelegationRequestSchema.parse(request({ agent_type: "build", profile: "deep" })).profile).toBe("deep");
    for (const agent_type of ["explore", "librarian"]) {
      expect(DelegationRequestSchema.parse(request({ agent_type, profile: "fast" })).profile).toBe("fast");
      expect(DelegationRequestSchema.parse(request({ agent_type, profile: "deep" })).profile).toBe("deep");
    }
    expect(() => DelegationRequestSchema.parse(request({ profile: "principal" }))).toThrow();
    expect(() => DelegationRequestSchema.parse(request({ profile: "visual" }))).toThrow();
  });

  test("describes static values while leaving target and Profile authorization to runtime capabilities", () => {
    const schema = z.toJSONSchema(DelegationRequestSchema) as {
      readonly properties: Record<string, { readonly description?: string }>;
    };
    const agentDescription = schema.properties.agent_type?.description ?? "";
    const profileDescription = schema.properties.profile?.description ?? "";

    expect(agentDescription).toContain("Delegated child Agent identity value");
    expect(agentDescription).toContain("parent/depth capability admission");
    expect(profileDescription).toContain("Delegated model-resource Profile value");
    expect(profileDescription).toContain("selected Agent/Profile pair is authorized");
    expect(profileDescription).not.toMatch(/analyst|build|explore|librarian/i);
  });

  test("keeps objective, title, and Skill names strict and non-empty", () => {
    expect(() => DelegationRequestSchema.parse(request({ title: " " }))).toThrow();
    expect(() => DelegationRequestSchema.parse(request({ objective: "" }))).toThrow();
    expect(() => DelegationRequestSchema.parse(request({ skills: ["Bad Skill"] }))).toThrow();
    expect(() => DelegationRequestSchema.parse(request({ background: "false" }))).toThrow();
  });

  test("accepts the exact title limit and rejects the first value beyond it", () => {
    const exactCodePointTitle = "界".repeat(MAX_DELEGATED_SESSION_TITLE_LENGTH);
    expect(Array.from(exactCodePointTitle)).toHaveLength(MAX_DELEGATED_SESSION_TITLE_LENGTH);
    expect(DelegationRequestSchema.safeParse(request({ title: exactCodePointTitle })).success).toBe(true);
    expect(DelegationRequestSchema.safeParse(request({ title: `${exactCodePointTitle}界` })).success)
      .toBe(false);

    expect(DelegationRequestSchema.safeParse(request({
      title: "t".repeat(MAX_DELEGATED_SESSION_TITLE_LENGTH + 1),
    })).success).toBe(false);
    expect(DelegationRequestSchema.safeParse(request({
      title: `${"t".repeat(MAX_DELEGATED_SESSION_TITLE_LENGTH)} `,
    })).success).toBe(false);
  });
});
