import { describe, expect, test } from "bun:test";
import {
  buildToolInputTree,
  TOOL_INPUT_MAX_DEPTH,
  TOOL_INPUT_MAX_NODES,
} from "./tool-input-presentation";

describe("buildToolInputTree", () => {
  test("preserves every recorded object key without tool-specific aliases", () => {
    const tree = buildToolInputTree({
      query: "react",
      libraryName: "React",
      count: 5,
      include_prereleases: false,
    });

    expect(tree.children?.map((node) => node.key)).toEqual([
      "query",
      "libraryName",
      "count",
      "include_prereleases",
    ]);
    expect(tree.children?.map((node) => node.value)).toEqual([
      "\"react\"",
      "\"React\"",
      "5",
      "false",
    ]);
  });

  test("keeps nested object keys and uses structural indexes only for arrays", () => {
    const tree = buildToolInputTree({
      questions: [{
        header: "Scope",
        question: "Proceed?",
        options: [{ label: "Yes", description: "Continue" }],
      }],
    });

    const questions = tree.children?.[0];
    const firstQuestion = questions?.children?.[0];
    expect(questions?.key).toBe("questions");
    expect(firstQuestion?.key).toBe("[0]");
    expect(firstQuestion?.children?.map((node) => node.key)).toEqual([
      "header",
      "question",
      "options",
    ]);
    expect(firstQuestion?.children?.[2]?.children?.[0]?.children?.map((node) => node.key)).toEqual([
      "label",
      "description",
    ]);
  });

  test("shows primitives directly without inventing an input parameter", () => {
    expect(buildToolInputTree("raw input")).toEqual({
      kind: "value",
      value: "\"raw input\"",
    });
    expect(buildToolInputTree(null)).toEqual({
      kind: "value",
      value: "null",
    });
  });

  test("previews long strings with explicit size and truncation metadata", () => {
    const value = Array.from({ length: 10 }, (_, index) => `line-${index}`).join("\n");
    const node = buildToolInputTree({ content: value }).children?.[0];

    expect(node?.value).toContain("line-0");
    expect(node?.value).toContain(`${value.length} chars, 10 lines`);
    expect(node?.value).toContain("truncated");
    expect(node?.value).not.toContain("line-9");
  });

  test("bounds node count and reports omitted entries", () => {
    const input = Object.fromEntries(
      Array.from({ length: TOOL_INPUT_MAX_NODES + 50 }, (_, index) => [`field_${index}`, index]),
    );
    const tree = buildToolInputTree(input);

    expect(tree.children).toHaveLength(TOOL_INPUT_MAX_NODES - 1);
    expect(tree.omittedChildren).toBe(51);
    expect(tree.truncated).toBe(true);
  });

  test("bounds nesting depth and reports hidden descendants", () => {
    let input: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < TOOL_INPUT_MAX_DEPTH + 2; depth += 1) {
      input = { nested: input };
    }

    let node = buildToolInputTree(input);
    for (let depth = 0; depth < TOOL_INPUT_MAX_DEPTH; depth += 1) {
      node = node.children?.[0]!;
    }
    expect(node.value).toContain("depth limit");
    expect(node.omittedChildren).toBe(1);
    expect(node.truncated).toBe(true);
  });

  test("keeps Tool summaries and Delegate runtime projection free of parameter contracts", async () => {
    const toolFormatSource = await Bun.file(new URL("./tool-format.ts", import.meta.url)).text();
    const summarySource = toolFormatSource.slice(
      toolFormatSource.indexOf("export function getToolSummary"),
      toolFormatSource.indexOf("// ─── Diff metadata"),
    );
    expect(summarySource).toContain("summarizeToolInput(input)");
    expect(summarySource).not.toContain("toolName ===");
    expect(summarySource).not.toContain("input.");
    expect(toolFormatSource).not.toContain("formatToolInputDetails");
    expect(toolFormatSource).not.toContain("getToolInvalidInputMessage");

    const delegationSource = await Bun.file(new URL("./delegation-card-model.ts", import.meta.url)).text();
    for (const contractField of ["agent_type", "profile", "skills", "objective", "background"]) {
      expect(delegationSource).not.toContain(contractField);
    }
  });
});
