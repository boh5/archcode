import { describe, expect, test } from "bun:test";
import { DigestBoundCursorError, paginateDigestBound } from "./pagination";

describe("digest-bound pagination", () => {
  test("enforces item-count and serialized-byte limits while traversing every item", () => {
    const items = Array.from({ length: 12 }, (_, index) => ({ index, value: "x".repeat(30) }));
    const seen: typeof items = [];
    let cursor: string | undefined;
    do {
      const page = paginateDigestBound({
        items,
        digest: "catalog-a",
        ...(cursor === undefined ? {} : { cursor }),
        maxItems: 5,
        maxSerializedBytes: 250,
        staleCursorCode: "CATALOG_CHANGED",
      });
      expect(page.items.length).toBeLessThanOrEqual(5);
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(250);
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(seen).toEqual(items);
  });

  test("rejects stale, malformed, out-of-range, and non-canonical cursors", () => {
    const first = paginateDigestBound({
      items: [1, 2],
      digest: "catalog-a",
      maxItems: 1,
      maxSerializedBytes: 1_000,
      staleCursorCode: "CATALOG_CHANGED",
    });
    for (const cursor of [
      first.nextCursor!,
      "not-base64-json",
      Buffer.from(JSON.stringify({ v: 1, digest: "catalog-a", index: 1, extra: true })).toString("base64url"),
      Buffer.from(JSON.stringify({ v: 1, digest: "catalog-a", index: 99 })).toString("base64url"),
    ]) {
      const digest = cursor === first.nextCursor ? "catalog-b" : "catalog-a";
      expect(() => paginateDigestBound({
        items: [1, 2],
        digest,
        cursor,
        maxItems: 1,
        maxSerializedBytes: 1_000,
        staleCursorCode: "CATALOG_CHANGED",
      })).toThrow(DigestBoundCursorError);
    }
  });
});
