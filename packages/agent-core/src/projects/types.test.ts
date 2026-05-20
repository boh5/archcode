import { describe, it, expect } from "bun:test";
import { ProjectInfoSchema } from "./types";

const validSample = {
  slug: "my-project",
  name: "My Project",
  workspaceRoot: "/Users/me/projects/my-project",
  addedAt: "2026-05-18T10:00:00.000Z",
};

describe("ProjectInfoSchema", () => {
  it("parses a valid ProjectInfo with lastOpenedAt", () => {
    const result = ProjectInfoSchema.parse({
      ...validSample,
      lastOpenedAt: "2026-05-18T12:00:00.000Z",
    });
    expect(result.slug).toBe("my-project");
    expect(result.name).toBe("My Project");
    expect(result.workspaceRoot).toBe("/Users/me/projects/my-project");
    expect(result.addedAt).toBe("2026-05-18T10:00:00.000Z");
    expect(result.lastOpenedAt).toBe("2026-05-18T12:00:00.000Z");
  });

  it("parses a valid ProjectInfo without lastOpenedAt", () => {
    const result = ProjectInfoSchema.parse(validSample);
    expect(result.slug).toBe("my-project");
    expect(result.lastOpenedAt).toBeUndefined();
  });

  it("rejects a ProjectInfo missing slug", () => {
    expect(() =>
      ProjectInfoSchema.parse({
        name: "No Slug",
        workspaceRoot: "/tmp/no-slug",
        addedAt: "2026-05-18T10:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects a ProjectInfo with unknown fields (strict mode)", () => {
    expect(() =>
      ProjectInfoSchema.parse({
        ...validSample,
        unknownField: "should be rejected",
      }),
    ).toThrow();
  });
});
