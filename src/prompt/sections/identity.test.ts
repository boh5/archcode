import { describe, expect, test } from "bun:test";
import { buildIdentitySection } from "./identity";

describe("buildIdentitySection", () => {
  test("includes agent id in identity", () => {
    const ctx = { agentId: "default" } as any;
    const result = buildIdentitySection(ctx);
    expect(result).toContain("default");
  });

  test("contains 'Specra'", () => {
    const ctx = { agentId: "test" } as any;
    const result = buildIdentitySection(ctx);
    expect(result).toContain("Specra");
  });

  test("different agent ids produce different outputs", () => {
    const ctx1 = { agentId: "default" } as any;
    const ctx2 = { agentId: "research" } as any;
    expect(buildIdentitySection(ctx1)).not.toBe(buildIdentitySection(ctx2));
  });
});