import { describe, expect, test } from "bun:test";
import { collectSessionTreeIds } from "./session-tree";

const tree = {
  session: { sessionId: "root" },
  children: [
    { session: { sessionId: "child" }, children: [{ session: { sessionId: "grandchild" }, children: [] }] },
    { session: { sessionId: "sibling" }, children: [] },
  ],
} as never;

describe("session tree ID traversal", () => {
  test("flattens depth-first", () => {
    expect(collectSessionTreeIds(tree)).toEqual(["root", "child", "grandchild", "sibling"]);
  });

  test("collects a subtree and returns empty for unknown IDs", () => {
    expect(collectSessionTreeIds(tree, "child")).toEqual(["child", "grandchild"]);
    expect(collectSessionTreeIds(tree, "missing")).toEqual([]);
  });
});
