export interface CanonicalUtf8 {
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly observedBytes: number;
  readonly canonicalBytes: number;
  readonly canonicalLines: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

export function canonicalizeUtf8(input: string | Uint8Array): CanonicalUtf8 {
  const observedBytes = typeof input === "string" ? encoder.encode(input).byteLength : input.byteLength;
  const text = typeof input === "string" ? input : decoder.decode(input);
  const bytes = encoder.encode(text);
  return {
    bytes,
    text,
    observedBytes,
    canonicalBytes: bytes.byteLength,
    canonicalLines: countUtf8Lines(bytes),
  };
}

export function decodeUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export interface Utf8HeadSlice {
  readonly text: string;
  readonly nextOffset: number;
  readonly truncated: boolean;
}

/**
 * Select a UTF-8-bounded prefix without encoding the unselected suffix.
 * Offsets are JavaScript string indexes and are always advanced by a whole
 * Unicode code point, so emitted text never ends between surrogate pairs.
 */
export function sliceUtf8Head(
  value: string,
  maxBytes: number,
  offset = 0,
  maxLines = Number.POSITIVE_INFINITY,
): Utf8HeadSlice {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.length) {
    throw new RangeError("UTF-8 slice offset must be a valid string index");
  }
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new RangeError("UTF-8 slice byte limit must be finite and non-negative");
  }
  if (maxLines < 1) return { text: "", nextOffset: offset, truncated: offset < value.length };

  let index = offset;
  let bytes = 0;
  let lines = 1;
  while (index < value.length) {
    const codePoint = value.codePointAt(index)!;
    const width = codePoint > 0xffff ? 2 : 1;
    const byteWidth = utf8CodePointWidth(codePoint);
    const isNewline = codePoint === 0x0a;
    if (bytes + byteWidth > maxBytes || (isNewline && lines >= maxLines)) break;
    bytes += byteWidth;
    if (isNewline) lines += 1;
    index += width;
  }

  return {
    text: value.slice(offset, index),
    nextOffset: index,
    truncated: index < value.length,
  };
}

function utf8CodePointWidth(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

export function countUtf8Lines(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) return 0;
  let lines = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) lines += 1;
  }
  if (bytes[bytes.byteLength - 1] !== 0x0a) lines += 1;
  return lines;
}

export function safeUtf8End(bytes: Uint8Array, maximumEnd: number): number {
  let end = Math.max(0, Math.min(maximumEnd, bytes.byteLength));
  if (end === bytes.byteLength) return end;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return end;
}

export function safeUtf8Start(bytes: Uint8Array, minimumStart: number): number {
  let start = Math.max(0, Math.min(minimumStart, bytes.byteLength));
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start += 1;
  return start;
}

export function headBoundary(
  bytes: Uint8Array,
  maxBytes: number,
  maxLines: number,
): number {
  const byteEnd = safeUtf8End(bytes, maxBytes);
  if (maxLines <= 0) return 0;
  let lines = 0;
  for (let index = 0; index < byteEnd; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    lines += 1;
    if (lines >= maxLines) return index + 1;
  }
  return byteEnd;
}

export function tailBoundary(
  bytes: Uint8Array,
  maxBytes: number,
  maxLines: number,
): number {
  if (maxBytes <= 0 || maxLines <= 0) return bytes.byteLength;
  const byteStart = safeUtf8Start(bytes, Math.max(0, bytes.byteLength - maxBytes));
  let lines = 0;
  for (let index = bytes.byteLength - 1; index >= byteStart; index -= 1) {
    if (bytes[index] !== 0x0a) continue;
    lines += 1;
    if (lines >= maxLines) return index + 1;
  }
  return byteStart;
}
