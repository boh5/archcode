import { ASSIGNMENT_PATTERN, SENSITIVE_KEY_PATTERN, TOKEN_PATTERN } from "./patterns";

/** Minimal streaming contract shared by redaction and bounded output capture. */
export interface StreamingTextRedactor {
  push(decodedChunk: string): string | Promise<string>;
  finish(): string | Promise<string>;
  abort?(): void;
}

export const REDACTION_MARKER = "[REDACTED:SECRET]";

export function redactString(value: string): string {
  // First replace assignment patterns (key=value where key contains sensitive words)
  let result = value.replace(ASSIGNMENT_PATTERN, `$1${REDACTION_MARKER}`);
  // Detection stays conservative, while display redaction preserves
  // recognizable absolute filesystem paths that the generic base64 branch
  // can otherwise mistake for slash-containing tokens.
  result = result.replace(TOKEN_PATTERN, (match, offset: number, source: string) => (
    isRecognizedAbsolutePathMatch(match, offset, source) ? match : REDACTION_MARKER
  ));
  return result;
}

export function redactValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === "string") {
    return redactString(value) as T;
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return REDACTION_MARKER as T;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen)) as T;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? REDACTION_MARKER
      : redactValue(item, seen);
  }

  return redacted as T;
}

export const SECRET_LITERAL_MIN_BYTES = 8;
export const SECRET_LITERAL_MAX_BYTES = 16 * 1024;
export const SECRET_LITERAL_MAX_COUNT = 256;
export const SECRET_LITERAL_MAX_TOTAL_BYTES = 64 * 1024;
const STREAM_CARRY_MAX_BYTES = 64 * 1024;

export class SecretLiteralPolicyError extends Error {
  readonly code = "SECRET_LITERAL_POLICY_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "SecretLiteralPolicyError";
  }
}

/** Runtime-scoped immutable redaction policy shared by every output boundary. */
export class SecretRedactionPolicy {
  readonly #literals: readonly string[];
  readonly #carryBytes: number;

  constructor(values: Iterable<string>) {
    const unique = [...new Set(values)];
    if (unique.length > SECRET_LITERAL_MAX_COUNT) {
      throw new SecretLiteralPolicyError(`At most ${SECRET_LITERAL_MAX_COUNT} secret literals are allowed`);
    }

    let totalBytes = 0;
    for (const value of unique) {
      const bytes = Buffer.byteLength(value, "utf8");
      if (bytes < SECRET_LITERAL_MIN_BYTES || bytes > SECRET_LITERAL_MAX_BYTES) {
        throw new SecretLiteralPolicyError(
          `Secret literals must contain ${SECRET_LITERAL_MIN_BYTES} to ${SECRET_LITERAL_MAX_BYTES} UTF-8 bytes`,
        );
      }
      totalBytes += bytes;
    }
    if (totalBytes > SECRET_LITERAL_MAX_TOTAL_BYTES) {
      throw new SecretLiteralPolicyError(
        `Secret literals exceed the ${SECRET_LITERAL_MAX_TOTAL_BYTES}-byte aggregate limit`,
      );
    }

    this.#literals = unique.sort((left, right) => right.length - left.length);
    this.#carryBytes = Math.min(
      STREAM_CARRY_MAX_BYTES,
      Math.max(128, ...this.#literals.map((literal) => Buffer.byteLength(literal, "utf8") + 64)),
    );
  }

  redactString(value: string): string {
    let result = redactString(value);
    for (const literal of this.#literals) {
      result = result.replaceAll(literal, REDACTION_MARKER);
    }
    return result;
  }

  redactValue<T>(value: T, seen = new WeakSet<object>()): T {
    if (typeof value === "string") return this.redactString(value) as T;
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return REDACTION_MARKER as T;
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item, seen)) as T;
    }
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      redacted[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? REDACTION_MARKER
        : this.redactValue(item, seen);
    }
    return redacted as T;
  }

  createStreamRedactor(): StreamingTextRedactor {
    let carry = "";
    let aborted = false;
    let openRun: "assignment" | "token" | undefined;
    const assignmentPattern = new RegExp(ASSIGNMENT_PATTERN.source, ASSIGNMENT_PATTERN.flags);
    const tokenPattern = new RegExp(TOKEN_PATTERN.source, TOKEN_PATTERN.flags);

    const consumeOpenRun = (text: string): { emitted: string; rest: string } => {
      if (openRun === undefined) return { emitted: "", rest: text };
      const isContinuation = openRun === "assignment"
        ? (character: string) => !/[\s&;,]/.test(character)
        : (character: string) => /[A-Za-z0-9_=/+\-]/.test(character);
      let index = 0;
      while (index < text.length && isContinuation(text[index]!)) index += 1;
      if (index === text.length) return { emitted: "", rest: "" };
      openRun = undefined;
      return { emitted: "", rest: text.slice(index) };
    };

    const lastMatchEndingAtInput = (
      pattern: RegExp,
      text: string,
      shouldTreatAsSecret: (match: RegExpExecArray, source: string) => boolean = () => true,
    ): RegExpExecArray | undefined => {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      let last: RegExpExecArray | undefined;
      while ((match = pattern.exec(text)) !== null) {
        if (
          match.index + match[0].length === text.length
          && shouldTreatAsSecret(match, text)
        ) last = match;
        if (match[0].length === 0) pattern.lastIndex += 1;
      }
      return last;
    };

    const extendCutPastCrossingMatches = (pattern: RegExp, text: string, initialCut: number): number => {
      pattern.lastIndex = 0;
      let cut = initialCut;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const end = match.index + match[0].length;
        if (match.index < cut && end > cut) cut = end;
        if (match[0].length === 0) pattern.lastIndex += 1;
      }
      return cut;
    };

    return {
      push: (decodedChunk) => {
        if (aborted) return "";
        let emitted = "";
        let offset = 0;
        while (offset < decodedChunk.length) {
          const end = utf8PrefixEnd(decodedChunk, offset, 16 * 1024);
          const consumed = consumeOpenRun(decodedChunk.slice(offset, end));
          emitted += consumed.emitted;
          offset = end;
          if (consumed.rest.length === 0) continue;
          carry += consumed.rest;

          if (Buffer.byteLength(carry, "utf8") <= this.#carryBytes) continue;

          const openAssignment = lastMatchEndingAtInput(assignmentPattern, carry);
          if (openAssignment !== undefined) {
            emitted += this.redactString(carry);
            carry = "";
            openRun = "assignment";
            continue;
          }
          const openToken = lastMatchEndingAtInput(
            tokenPattern,
            carry,
            (match, source) => !isRecognizedAbsolutePathMatch(match[0], match.index, source),
          );
          if (openToken !== undefined) {
            emitted += this.redactString(carry);
            carry = "";
            openRun = "token";
            continue;
          }

          let cut = utf8SuffixStart(carry, this.#carryBytes);
          cut = extendCutPastCrossingMatches(assignmentPattern, carry, cut);
          cut = extendCutPastCrossingMatches(tokenPattern, carry, cut);
          emitted += this.redactString(carry.slice(0, cut));
          carry = carry.slice(cut);
        }
        return emitted;
      },
      finish: () => {
        if (aborted) return "";
        const emitted = this.redactString(carry);
        carry = "";
        openRun = undefined;
        return emitted;
      },
      abort: () => {
        aborted = true;
        carry = "";
        openRun = undefined;
      },
    };
  }
}

const ABSOLUTE_PATH_ROOT = /^\/(?:Users|Volumes|home|opt|private|tmp|usr|var|workspace)(?:\/|$)/;

function isRecognizedAbsolutePathMatch(match: string, offset: number, source: string): boolean {
  const candidate = match.startsWith("/")
    ? match
    : source[offset - 1] === "/"
      ? `/${match}`
      : undefined;
  if (candidate === undefined || !ABSOLUTE_PATH_ROOT.test(candidate)) return false;
  return candidate.slice(1).split("/").filter(Boolean).length >= 3;
}

function utf8PrefixEnd(value: string, start: number, maxBytes: number): number {
  let index = start;
  let bytes = 0;
  while (index < value.length) {
    const codePoint = value.codePointAt(index)!;
    const width = utf8CodePointBytes(codePoint);
    if (bytes + width > maxBytes && index > start) break;
    bytes += width;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return index;
}

function utf8SuffixStart(value: string, maxBytes: number): number {
  let index = value.length;
  let bytes = 0;
  while (index > 0) {
    let start = index - 1;
    const low = value.charCodeAt(start);
    if (low >= 0xdc00 && low <= 0xdfff && start > 0) {
      const high = value.charCodeAt(start - 1);
      if (high >= 0xd800 && high <= 0xdbff) start -= 1;
    }
    const codePoint = value.codePointAt(start)!;
    const width = utf8CodePointBytes(codePoint);
    if (bytes + width > maxBytes) break;
    bytes += width;
    index = start;
  }
  return index;
}

function utf8CodePointBytes(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}
