import { describe, expect, test } from "bun:test";
import { createGitStatusCaptureSink } from "./git-status";

describe("git status canonical capture sink", () => {
  test("converts NUL porcelain separators across arbitrary process chunks", async () => {
    const chunks: Uint8Array[] = [];
    const capture = { write: async (chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
      return "accepted" as const;
    } };
    const sink = createGitStatusCaptureSink(capture as never);
    await sink.write("stdout", new TextEncoder().encode("M  src/a.ts\0?? "));
    await sink.write("stdout", new TextEncoder().encode("new.ts\0"));
    await sink.write("stderr", new TextEncoder().encode("ignored"));
    expect(new TextDecoder().decode(concat(chunks))).toBe("M  src/a.ts\n?? new.ts\n");
  });
});

function concat(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}
