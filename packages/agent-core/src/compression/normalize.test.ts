import { describe, expect, test } from "bun:test";
import { normalizeText, normalizeValue } from "./normalize";

describe("compression normalization", () => {
  test("collapses whitespace and recursively sorts object keys", () => {
    expect(normalizeText("  one\n two\tthree  ")).toBe("one two three");
    expect(normalizeValue({ z: "  z  ", a: { y: "y\nvalue" } })).toEqual({
      a: { y: "y value" },
      z: "z",
    });
  });

  test("preserves array order and primitive values", () => {
    expect(normalizeValue([" a ", { b: 1, a: 2 }])).toEqual(["a", { a: 2, b: 1 }]);
    expect(normalizeValue(null)).toBeNull();
  });
});
