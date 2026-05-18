import { describe, expect, test } from "bun:test";
import {
  formatFrontmatter,
  formatSimpleYaml,
  parseFrontmatter,
  parseSimpleYaml,
} from "./frontmatter";

describe("simple YAML helpers", () => {
  test("parses key value lines and skips comments", () => {
    expect(parseSimpleYaml("# comment\nname: Test\ntype: project\nignored\n")).toEqual({
      name: "Test",
      type: "project",
    });
  });

  test("formats records as simple YAML", () => {
    expect(formatSimpleYaml({ name: "Test", type: "project" })).toBe(
      "name: Test\ntype: project",
    );
  });
});

describe("frontmatter helpers", () => {
  test("roundtrips generic frontmatter and body", () => {
    const content = formatFrontmatter({ title: "Workflow", owner: "agent" }, "Body");

    expect(parseFrontmatter(content)).toEqual({
      frontmatter: { title: "Workflow", owner: "agent" },
      body: "Body",
    });
  });

  test("throws when delimiters are missing", () => {
    expect(() => parseFrontmatter("no frontmatter")).toThrow(
      "does not start with frontmatter delimiter",
    );
    expect(() => parseFrontmatter("---\ntitle: X")).toThrow(
      "No closing frontmatter delimiter found",
    );
  });
});
