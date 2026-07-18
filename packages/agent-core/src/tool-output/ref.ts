import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import {
  TOOL_OUTPUT_CURSOR_MAX_BYTES,
  TOOL_OUTPUT_REF_BYTES,
  TOOL_OUTPUT_REF_LENGTH,
} from "./constants";
import { ToolOutputError } from "./errors";
import type { OutputRef } from "./artifact-types";

const OUTPUT_REF_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CURSOR_IV_BYTES = 12;
const CURSOR_TAG_BYTES = 16;

export function createOutputRef(): OutputRef {
  const ref = randomBytes(TOOL_OUTPUT_REF_BYTES).toString("base64url");
  if (ref.length !== TOOL_OUTPUT_REF_LENGTH) {
    throw new ToolOutputError("TOOL_OUTPUT_UNAVAILABLE");
  }
  return ref as OutputRef;
}

export function isOutputRef(value: unknown): value is OutputRef {
  return typeof value === "string" && OUTPUT_REF_PATTERN.test(value);
}

export class OpaqueCursorCodec {
  constructor(private readonly key: Uint8Array) {
    if (key.byteLength !== 32) {
      throw new ToolOutputError(
        "TOOL_OUTPUT_POLICY_VIOLATION",
        "Tool output cursor key must contain exactly 32 bytes",
      );
    }
  }

  encode(payload: Readonly<Record<string, unknown>>): string {
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    if (plaintext.byteLength > TOOL_OUTPUT_CURSOR_MAX_BYTES) {
      throw new ToolOutputError("TOOL_OUTPUT_POLICY_VIOLATION");
    }
    const iv = randomBytes(CURSOR_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
  }

  decode(token: string): unknown {
    try {
      if (
        !BASE64URL_PATTERN.test(token) ||
        Buffer.byteLength(token, "utf8") > TOOL_OUTPUT_CURSOR_MAX_BYTES * 2
      ) {
        throw new Error("oversized cursor");
      }
      const bytes = Buffer.from(token, "base64url");
      if (bytes.toString("base64url") !== token) {
        throw new Error("non-canonical base64url cursor");
      }
      if (bytes.byteLength <= CURSOR_IV_BYTES + CURSOR_TAG_BYTES) {
        throw new Error("short cursor");
      }
      const iv = bytes.subarray(0, CURSOR_IV_BYTES);
      const tag = bytes.subarray(CURSOR_IV_BYTES, CURSOR_IV_BYTES + CURSOR_TAG_BYTES);
      const ciphertext = bytes.subarray(CURSOR_IV_BYTES + CURSOR_TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (plaintext.byteLength > TOOL_OUTPUT_CURSOR_MAX_BYTES) {
        throw new Error("oversized plaintext");
      }
      return JSON.parse(plaintext.toString("utf8"));
    } catch {
      throw new ToolOutputError("TOOL_OUTPUT_INVALID_CURSOR");
    }
  }
}
