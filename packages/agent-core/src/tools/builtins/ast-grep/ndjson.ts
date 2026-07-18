import type { ProcessOutputSink, ProcessOutputStream } from "../../../process/types";
import { BoundedByteBuffer } from "../../../utils/bounded-byte-buffer";

export const AST_GREP_MAX_RECORD_BYTES = 1024 * 1024;
export const AST_GREP_TOKENIZER_MAX_STATE_BYTES = 64 * 1024;
const AST_GREP_SMALL_RECORD_BYTES = 16 * 1024;
const AST_GREP_MAX_FILE_BYTES = 8 * 1024;

export interface AstGrepNdjsonRecord {
  readonly file: string;
  readonly bytes: number;
}

/**
 * Incremental `--json=stream` validator. Records may be 1 MiB, but only a
 * 16 KiB small-record spool plus an 8 KiB extracted file token are retained.
 */
export class AstGrepNdjsonCollector implements ProcessOutputSink {
  #parser = new AstGrepRecordParser();
  #failure: Error | undefined;

  constructor(readonly onRecord: (record: AstGrepNdjsonRecord) => void) {}

  write(stream: ProcessOutputStream, chunk: Uint8Array): void {
    if (stream !== "stdout" || this.#failure !== undefined) return;
    try {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline < 0 ? chunk.byteLength : newline;
        if (end > offset) this.#parser.push(chunk.subarray(offset, end));
        if (newline < 0) return;
        this.#finishRecord();
        offset = newline + 1;
      }
    } catch (error) {
      this.#failure = asError(error);
      throw this.#failure;
    }
  }

  finish(): void {
    if (this.#failure !== undefined) throw this.#failure;
    try {
      if (this.#parser.hasBytes) this.#finishRecord();
    } catch (error) {
      this.#failure = asError(error);
      throw this.#failure;
    }
  }

  stats(): { recordBytes: number; bufferedBytes: number } {
    return this.#parser.stats();
  }

  #finishRecord(): void {
    const record = this.#parser.finish();
    this.#parser = new AstGrepRecordParser();
    if (record !== undefined) this.onRecord(record);
  }
}

class AstGrepRecordParser {
  readonly #decoder = new TextDecoder();
  #small: BoundedByteBuffer | undefined = new BoundedByteBuffer(AST_GREP_SMALL_RECORD_BYTES);
  #recordBytes = 0;
  #depth = 0;
  #rootStarted = false;
  #rootClosed = false;
  #inString = false;
  #escape = false;
  #unicodeDigits = 0;
  #unicodeValue = 0;
  #capture: "key" | "file" | undefined;
  #captured = "";
  #expectKey = false;
  #lastKeyIsFile = false;
  #pendingFileValue = false;
  #file: string | undefined;

  get hasBytes(): boolean {
    return this.#recordBytes > 0;
  }

  push(bytes: Uint8Array): void {
    this.#recordBytes += bytes.byteLength;
    if (this.#recordBytes > AST_GREP_MAX_RECORD_BYTES) {
      throw new Error(`ast-grep JSON stream record exceeds ${AST_GREP_MAX_RECORD_BYTES} bytes`);
    }
    if (this.#small !== undefined && !this.#small.append(bytes)) this.#small = undefined;
    for (let offset = 0; offset < bytes.byteLength; offset += 8 * 1024) {
      this.#consumeText(this.#decoder.decode(bytes.subarray(offset, offset + 8 * 1024), { stream: true }));
    }
  }

  finish(): AstGrepNdjsonRecord | undefined {
    this.#consumeText(this.#decoder.decode());
    if (!this.#rootStarted && this.#recordBytes > 0) {
      if (this.#small !== undefined && new TextDecoder().decode(this.#small.bytes()).trim() === "") return undefined;
      throw new Error("Failed to parse ast-grep JSON stream record");
    }
    if (!this.#rootStarted) return undefined;
    if (this.#inString || this.#escape || this.#unicodeDigits > 0 || this.#depth !== 0 || !this.#rootClosed) {
      throw new Error("Failed to parse ast-grep JSON stream record");
    }

    if (this.#small !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(this.#small.bytes()));
      } catch (error) {
        throw new Error("Failed to parse ast-grep JSON stream record", { cause: error });
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as Record<string, unknown>).file !== "string") {
        throw new Error("ast-grep JSON stream record must contain a string file field");
      }
      this.#file = (parsed as Record<string, unknown>).file as string;
    }
    if (this.#file === undefined) {
      throw new Error("ast-grep JSON stream record must contain a string file field");
    }
    return { file: this.#file, bytes: this.#recordBytes };
  }

  stats(): { recordBytes: number; bufferedBytes: number } {
    return {
      recordBytes: this.#recordBytes,
      bufferedBytes: (this.#small?.byteLength ?? 0) + Buffer.byteLength(this.#file ?? this.#captured, "utf8"),
    };
  }

  #consumeText(text: string): void {
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index]!;
      if (this.#inString) {
        this.#consumeStringCharacter(character);
        continue;
      }
      if (/\s/.test(character)) continue;
      if (this.#rootClosed) throw new Error("Failed to parse ast-grep JSON stream record");

      if (character === '"') {
        if (this.#pendingFileValue) {
          this.#capture = "file";
          this.#pendingFileValue = false;
          this.#captured = "";
        } else if (this.#depth === 1 && this.#expectKey) {
          this.#capture = "key";
          this.#captured = "";
        } else {
          this.#capture = undefined;
        }
        this.#inString = true;
        continue;
      }
      if (this.#pendingFileValue) {
        throw new Error("ast-grep JSON stream record file field must be a string");
      }
      if (character === "{") {
        if (!this.#rootStarted) {
          this.#rootStarted = true;
          this.#expectKey = true;
        }
        this.#depth += 1;
        continue;
      }
      if (character === "[") {
        if (!this.#rootStarted) throw new Error("Failed to parse ast-grep JSON stream record");
        this.#depth += 1;
        continue;
      }
      if (character === "}" || character === "]") {
        this.#depth -= 1;
        if (this.#depth < 0) throw new Error("Failed to parse ast-grep JSON stream record");
        if (this.#depth === 0) this.#rootClosed = true;
        continue;
      }
      if (this.#depth === 1 && character === ":") {
        this.#pendingFileValue = this.#lastKeyIsFile;
        this.#lastKeyIsFile = false;
        continue;
      }
      if (this.#depth === 1 && character === ",") {
        this.#expectKey = true;
      }
    }
  }

  #consumeStringCharacter(character: string): void {
    if (this.#unicodeDigits > 0) {
      if (!/[0-9a-f]/i.test(character)) throw new Error("Failed to parse ast-grep JSON stream record");
      this.#unicodeValue = (this.#unicodeValue << 4) | Number.parseInt(character, 16);
      this.#unicodeDigits -= 1;
      if (this.#unicodeDigits === 0) this.#appendCaptured(String.fromCharCode(this.#unicodeValue));
      return;
    }
    if (this.#escape) {
      this.#escape = false;
      if (character === "u") {
        this.#unicodeDigits = 4;
        this.#unicodeValue = 0;
        return;
      }
      const escaped = ({ '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<string, string>)[character];
      if (escaped === undefined) throw new Error("Failed to parse ast-grep JSON stream record");
      this.#appendCaptured(escaped);
      return;
    }
    if (character === "\\") {
      this.#escape = true;
      return;
    }
    if (character === '"') {
      this.#inString = false;
      if (this.#capture === "key") {
        this.#lastKeyIsFile = this.#captured === "file";
        this.#expectKey = false;
      } else if (this.#capture === "file") {
        if (this.#file !== undefined) throw new Error("ast-grep JSON stream record contains duplicate file fields");
        this.#file = this.#captured;
      }
      this.#capture = undefined;
      this.#captured = "";
      return;
    }
    if (character.charCodeAt(0) < 0x20) throw new Error("Failed to parse ast-grep JSON stream record");
    this.#appendCaptured(character);
  }

  #appendCaptured(value: string): void {
    if (this.#capture === undefined) return;
    this.#captured += value;
    const limit = this.#capture === "key" ? 16 : AST_GREP_MAX_FILE_BYTES;
    if (Buffer.byteLength(this.#captured, "utf8") > limit) {
      if (this.#capture === "key") {
        this.#capture = undefined;
        this.#captured = "";
        return;
      }
      throw new Error(`ast-grep file field exceeds ${AST_GREP_MAX_FILE_BYTES} bytes`);
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Failed to parse ast-grep JSON stream record");
}
