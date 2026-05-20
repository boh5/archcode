import { describe, expect, test } from "bun:test";
import { buildProjectSection } from "./project";

describe("buildProjectSection", () => {
  test("contains 'Project Context' header", () => {
    const result = buildProjectSection("some content");
    expect(result).toContain("## Project Context");
  });

  test("includes the provided AGENTS.md content", () => {
    const content = "# My Project\n\nThis is a test project.";
    const result = buildProjectSection(content);
    expect(result).toContain(content);
  });

  test("preserves content exactly", () => {
    const content = "Line 1\nLine 2\n- List item\n```js\nconsole.log('hi')\n```";
    const result = buildProjectSection(content);
    expect(result).toContain(content);
  });
});