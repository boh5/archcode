import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempRoot } from "./test-temp-root";

describe("createTestTempRoot", () => {
  test("gives every caller a unique owned leaf", () => {
    const first = createTestTempRoot("memory extraction");
    const second = createTestTempRoot("memory extraction");

    expect(first.path).not.toBe(second.path);
    expect(first.path).toMatch(/memory-extraction-[0-9a-f-]{36}$/);
  });

  test("cleanup removes only the owned leaf", async () => {
    const first = createTestTempRoot("cleanup-first");
    const second = createTestTempRoot("cleanup-second");
    await mkdir(join(first.path, "nested"), { recursive: true });
    await mkdir(join(second.path, "nested"), { recursive: true });
    const firstMarker = join(first.path, "nested", "marker.txt");
    const secondMarker = join(second.path, "nested", "marker.txt");
    await Bun.write(firstMarker, "first");
    await Bun.write(secondMarker, "second");

    await first.cleanup();

    expect(await Bun.file(firstMarker).exists()).toBe(false);
    expect(await Bun.file(secondMarker).exists()).toBe(true);
    await second.cleanup();
  });
});
