import { describe, expect, test } from "bun:test";
import { buildToolSection } from "./tools";

function makeCtx(tools: string[]) {
  return { allowedTools: tools } as any;
}

describe("buildToolSection", () => {
  test("lists all provided tools", () => {
    const result = buildToolSection(makeCtx(["file_read", "file_write", "grep"]));
    expect(result).toContain("file_read");
    expect(result).toContain("file_write");
    expect(result).toContain("grep");
  });

  test("includes 'Tools' header", () => {
    const result = buildToolSection(makeCtx(["file_read"]));
    expect(result).toContain("## Tools");
  });

  test("returns 'No tools available' when empty", () => {
    const result = buildToolSection(makeCtx([]));
    expect(result).toContain("No tools available");
  });

  test("formats each tool as a list item", () => {
    const result = buildToolSection(makeCtx(["bash", "glob"]));
    expect(result).toContain("- bash");
    expect(result).toContain("- glob");
  });

  test("tells the model to batch only independent non-interactive lookups", () => {
    const result = buildToolSection(makeCtx(["grep", "glob", "bash"]));

    expect(result).toContain("issue them together in one model turn");
    expect(result).toContain("parallelizes concurrency-safe calls and serializes the rest");
    expect(result).toContain("do not batch interactive or mutating operations");
  });

});
