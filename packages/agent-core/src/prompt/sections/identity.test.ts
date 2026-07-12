import { describe, expect, test } from "bun:test";
import { buildIdentitySection } from "./identity";

describe("buildIdentitySection", () => {
  test("identifies ArchCode without exposing the internal prompt profile", () => {
    const ctx = { promptProfileId: "default" } as any;
    const result = buildIdentitySection(ctx);

    expect(result).toContain("ArchCode");
    expect(result).not.toContain("prompt profile");
    expect(result).not.toContain("default");
  });

  test("prompt profile selection does not change model-visible identity", () => {
    const ctx1 = { promptProfileId: "default" } as any;
    const ctx2 = { promptProfileId: "research" } as any;
    expect(buildIdentitySection(ctx1)).toBe(buildIdentitySection(ctx2));
  });
});
