import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { projectCanonicalText } from "./projection";
import { createOutputRef, isOutputRef, OpaqueCursorCodec } from "./ref";
import { canonicalizeUtf8, decodeUtf8, safeUtf8End, safeUtf8Start } from "./utf8";

describe("tool output UTF-8 projection", () => {
  test("normalizes invalid input once and reports observed versus canonical bytes", () => {
    const canonical = canonicalizeUtf8(new Uint8Array([0x61, 0xff, 0x62]));
    expect(canonical.text).toBe("a�b");
    expect(canonical.observedBytes).toBe(3);
    expect(canonical.canonicalBytes).toBe(5);
    expect(decodeUtf8(canonical.bytes)).toBe("a�b");
  });

  test("never cuts through a UTF-8 code point", () => {
    const bytes = new TextEncoder().encode("ab😀cd");
    expect(decodeUtf8(bytes.subarray(0, safeUtf8End(bytes, 4)))).toBe("ab");
    expect(decodeUtf8(bytes.subarray(safeUtf8Start(bytes, 4)))).toBe("cd");
  });

  test("head-tail projection preserves both ends within byte and line limits", () => {
    const bytes = new TextEncoder().encode(
      ["HEAD_SENTINEL", ...Array.from({ length: 30 }, (_, index) => `line-${index}`), "TAIL_SENTINEL"].join("\n"),
    );
    const projection = projectCanonicalText(bytes, "head-tail", {
      maxBytes: 100,
      maxLines: 8,
    });
    expect(projection.completeness).toBe("partial");
    expect(projection.preview).toContain("HEAD_SENTINEL");
    expect(projection.preview).toContain("TAIL_SENTINEL");
    expect(projection.previewBytes).toBeLessThanOrEqual(100);
    expect(projection.previewLines).toBeLessThanOrEqual(8);
    expect(projection.omittedBytes).toBeGreaterThan(0);
  });

  test("default model projection has one strict 50 KiB and 2,000-line budget", () => {
    const bytes = new TextEncoder().encode(
      ["HEAD", ...Array.from({ length: 20_000 }, (_, index) => `line-${index}`), "TAIL"].join("\n"),
    );
    const projection = projectCanonicalText(bytes);
    expect(projection.previewBytes).toBeLessThanOrEqual(50 * 1024);
    expect(projection.previewLines).toBeLessThanOrEqual(2_000);
    expect(projection.preview).toContain("HEAD");
    expect(projection.preview).toContain("TAIL");
  });
});

describe("opaque tool output identifiers", () => {
  test("uses 128-bit base64url output refs", () => {
    const refs = new Set(Array.from({ length: 100 }, () => createOutputRef()));
    expect(refs.size).toBe(100);
    for (const ref of refs) {
      expect(ref).toHaveLength(22);
      expect(isOutputRef(ref)).toBe(true);
      expect(ref).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  test("authenticates and encrypts cursor state", () => {
    const codec = new OpaqueCursorCodec(randomBytes(32));
    const cursor = codec.encode({ scope: "private", offset: 42 });
    expect(cursor).not.toContain("private");
    expect(codec.decode(cursor)).toEqual({ scope: "private", offset: 42 });
    const replacement = cursor.endsWith("A") ? "B" : "A";
    expect(() => codec.decode(`${cursor.slice(0, -1)}${replacement}`)).toThrow(
      "Tool output cursor is invalid",
    );
    const alias = nonCanonicalBase64UrlAlias(cursor);
    expect(Buffer.from(alias, "base64url")).toEqual(Buffer.from(cursor, "base64url"));
    expect(() => codec.decode(alias)).toThrow("Tool output cursor is invalid");
  });
});

function nonCanonicalBase64UrlAlias(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const remainder = value.length % 4;
  if (remainder !== 2 && remainder !== 3) throw new Error("Cursor has no unused tail bits");
  const last = alphabet.indexOf(value.at(-1)!);
  if (last < 0) throw new Error("Invalid base64url test value");
  const unusedBits = remainder === 2 ? 4 : 2;
  const alias = last | ((last + 1) & ((1 << unusedBits) - 1));
  if (alias === last) throw new Error("Could not create base64url alias");
  return `${value.slice(0, -1)}${alphabet[alias]}`;
}
