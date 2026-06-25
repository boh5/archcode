import { describe, expect, test } from "bun:test";
import { buildIdentitySection } from "./identity";

describe("buildIdentitySection", () => {
  test("includes prompt profile in identity", () => {
    const ctx = { promptProfileId: "default" } as any;
    const result = buildIdentitySection(ctx);
    expect(result).toContain("default");
  });

  test("contains 'ArchCode'", () => {
    const ctx = { promptProfileId: "test" } as any;
    const result = buildIdentitySection(ctx);
    expect(result).toContain("ArchCode");
  });

  test("different prompt profiles produce different outputs", () => {
    const ctx1 = { promptProfileId: "default" } as any;
    const ctx2 = { promptProfileId: "research" } as any;
    expect(buildIdentitySection(ctx1)).not.toBe(buildIdentitySection(ctx2));
  });
});
