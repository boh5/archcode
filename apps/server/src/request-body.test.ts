import { describe, expect, test } from "bun:test";
import { readBoundedJsonBody } from "./request-body";

describe("readBoundedJsonBody", () => {
  test("streams a body with no content-length and cancels immediately at the hard limit", async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new Uint8Array(8));
        else if (pulls === 2) controller.enqueue(new Uint8Array(9));
        else controller.enqueue(new Uint8Array(1_000_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://localhost/test", { method: "POST", body: stream });

    await expect(readBoundedJsonBody(request, { maxBytes: 16, label: "Test body" }))
      .rejects.toMatchObject({ httpStatus: 413 });
    expect(cancelled).toBe(true);
    expect(pulls).toBe(2);
  });

  test("rejects invalid UTF-8 instead of replacement-decoding it", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      body: Uint8Array.of(0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d),
    });
    await expect(readBoundedJsonBody(request, { maxBytes: 32, label: "Test body" }))
      .rejects.toMatchObject({ httpStatus: 400 });
  });

  test("parses exactly-at-limit UTF-8 JSON", async () => {
    const encoded = new TextEncoder().encode('{"ok":true}');
    const request = new Request("http://localhost/test", { method: "POST", body: encoded });
    expect(await readBoundedJsonBody(request, { maxBytes: encoded.byteLength, label: "Test body" }))
      .toEqual({ ok: true });
  });
});
