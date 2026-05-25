import { describe, expect, test } from "bun:test";
import { DelegateInputSchema } from "../tools/builtins/delegate";
import { DELEGATION_TOOLS } from "./constants";
import { DELEGATION_TOOLS as EXPORTED_DELEGATION_TOOLS } from "./tool-filter";

describe("tool-filter exports", () => {
  test("re-exports delegation tools for depth filtering callers", () => {
    expect(EXPORTED_DELEGATION_TOOLS).toBe(DELEGATION_TOOLS);
    expect(EXPORTED_DELEGATION_TOOLS).toEqual(["delegate", "wait_for_reminder", "background_output"]);
  });
});

describe("delegate input schema", () => {
  test("delegate input schema accepts dynamic non-empty agent types", () => {
    const shape = DelegateInputSchema.shape;
    expect(shape.agent_type).toBeDefined();

    const valid = DelegateInputSchema.safeParse({
      agent_type: "explore",
      prompt: "test prompt",
      skills: [],
    });
    expect(valid.success).toBe(true);

    const dynamic = DelegateInputSchema.safeParse({
      agent_type: "unknown_type",
      prompt: "test prompt",
      skills: [],
    });
    expect(dynamic.success).toBe(true);

    const invalid = DelegateInputSchema.safeParse({
      agent_type: "",
      prompt: "test prompt",
      skills: [],
    });
    expect(invalid.success).toBe(false);

    const missingSkills = DelegateInputSchema.safeParse({
      agent_type: "explore",
      prompt: "test prompt",
    });
    expect(missingSkills.success).toBe(false);
  });
});
