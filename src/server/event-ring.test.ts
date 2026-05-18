import { describe, expect, test } from "bun:test";
import { EventRing } from "./event-ring";

describe("EventRing", () => {
  test("push returns entries with incrementing ids", () => {
    const ring = new EventRing();

    expect(ring.push("stream", "one").id).toBe(1);
    expect(ring.push("stream", "two").id).toBe(2);
    expect(ring.push("stream", "three").id).toBe(3);
  });

  test("since(0) returns all entries", () => {
    const ring = new EventRing();
    const first = ring.push("stream", "one");
    const second = ring.push("stream", "two");

    expect(ring.since(0)).toEqual([first, second]);
  });

  test("since(lastId) returns entries with id greater than lastId", () => {
    const ring = new EventRing();
    for (let index = 1; index <= 7; index += 1) {
      ring.push("stream", String(index));
    }

    expect(ring.since(5).map((entry) => entry.id)).toEqual([6, 7]);
  });

  test("since(currentId) returns an empty list", () => {
    const ring = new EventRing();
    ring.push("stream", "one");
    ring.push("stream", "two");

    expect(ring.since(ring.currentId)).toEqual([]);
  });

  test("since id ahead of currentId returns an empty list", () => {
    const ring = new EventRing();
    ring.push("stream", "one");

    expect(ring.since(ring.currentId + 100)).toEqual([]);
  });

  test("buffer evicts oldest entries over capacity", () => {
    const ring = new EventRing(1000);
    for (let index = 1; index <= 1001; index += 1) {
      ring.push("stream", String(index));
    }

    const entries = ring.since(0);
    expect(entries).toHaveLength(1000);
    expect(entries[0]?.id).toBe(2);
    expect(entries.at(-1)?.id).toBe(1001);
  });
});
