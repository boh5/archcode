import { describe, expect, test } from "bun:test";
import { createClientUuid, type ClientUuidSource } from "./client-uuid";

describe("createClientUuid", () => {
  test("uses randomUUID when the secure-context API is available", () => {
    const expected = "123e4567-e89b-42d3-a456-426614174000";
    const source: ClientUuidSource = {
      randomUUID: () => expected,
      getRandomValues: () => {
        throw new Error("fallback should not run");
      },
    };

    expect(createClientUuid(source)).toBe(expected);
  });

  test("creates a valid v4 UUID when randomUUID is unavailable over HTTP", () => {
    const source: ClientUuidSource = {
      getRandomValues: (array) => {
        array.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
        return array;
      },
    };

    expect(createClientUuid(source)).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });
});
