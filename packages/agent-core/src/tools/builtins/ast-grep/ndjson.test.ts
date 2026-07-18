import { describe, expect, test } from "bun:test";

import {
  AST_GREP_MAX_RECORD_BYTES,
  AST_GREP_TOKENIZER_MAX_STATE_BYTES,
  AstGrepNdjsonCollector,
} from "./ndjson";

describe("AstGrepNdjsonCollector", () => {
  test("decodes records split across chunks and UTF-8 code points", () => {
    const records: unknown[] = [];
    const collector = new AstGrepNdjsonCollector((record) => records.push(record));
    const bytes = new TextEncoder().encode('{"file":"你好.ts","text":"你好"}\n{"file":"ok.ts","text":"ok"}');

    collector.write("stdout", bytes.subarray(0, 11));
    collector.write("stderr", new TextEncoder().encode("ignored"));
    collector.write("stdout", bytes.subarray(11));
    collector.finish();

    expect(records).toEqual([
      { file: "你好.ts", bytes: Buffer.byteLength('{"file":"你好.ts","text":"你好"}') },
      { file: "ok.ts", bytes: Buffer.byteLength('{"file":"ok.ts","text":"ok"}') },
    ]);
  });

  test("rejects malformed JSON records", () => {
    const collector = new AstGrepNdjsonCollector(() => undefined);
    expect(() => collector.write("stdout", new TextEncoder().encode("not-json\n"))).toThrow(
      "Failed to parse ast-grep JSON stream record",
    );
    expect(() => collector.finish()).toThrow("Failed to parse ast-grep JSON stream record");
  });

  test("rejects a record larger than the fixed record cap", () => {
    const collector = new AstGrepNdjsonCollector(() => undefined);
    const oversized = new TextEncoder().encode(`{"file":"x.ts","text":"${"x".repeat(AST_GREP_MAX_RECORD_BYTES)}"}`);

    expect(() => collector.write("stdout", oversized)).toThrow(
      `ast-grep JSON stream record exceeds ${AST_GREP_MAX_RECORD_BYTES} bytes`,
    );
  });

  test("accepts a near-1 MiB record while tokenizer-retained state stays below 64 KiB", () => {
    const records: unknown[] = [];
    const collector = new AstGrepNdjsonCollector((record) => records.push(record));
    const record = new TextEncoder().encode(`{"file":"large.ts","text":"${"x".repeat(900 * 1024)}"}`);

    for (let offset = 0; offset < record.byteLength; offset += 4093) {
      collector.write("stdout", record.subarray(offset, offset + 4093));
      expect(collector.stats().bufferedBytes).toBeLessThanOrEqual(AST_GREP_TOKENIZER_MAX_STATE_BYTES);
    }
    collector.finish();

    expect(records).toEqual([{ file: "large.ts", bytes: record.byteLength }]);
  });
});
