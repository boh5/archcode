import { describe, expect, test } from "bun:test";
import { sortJsonValue } from "./sort-json-value";

describe("sortJsonValue", () => {
  test("sorts nested object keys while preserving arrays", () => {
    const value = { z: { b: 2, a: 1 }, a: [{ d: 4, c: 3 }] };
    expect(sortJsonValue(value)).toEqual({ a: [{ c: 3, d: 4 }], z: { a: 1, b: 2 } });
    expect(value).toEqual({ z: { b: 2, a: 1 }, a: [{ d: 4, c: 3 }] });
  });

  test("passes through primitives and null", () => {
    expect(sortJsonValue(null)).toBeNull();
    expect(sortJsonValue("value")).toBe("value");
  });
});
