export interface DigestBoundPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface DigestBoundPaginationOptions<T> {
  readonly items: readonly T[];
  readonly digest: string;
  readonly cursor?: string;
  readonly maxItems: number;
  readonly maxSerializedBytes: number;
  readonly staleCursorCode: string;
  readonly serialize?: (page: DigestBoundPage<T>) => string;
}

export class DigestBoundCursorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DigestBoundCursorError";
  }
}

interface CursorPayload {
  readonly v: 1;
  readonly digest: string;
  readonly index: number;
}

export function paginateDigestBound<T>(
  options: DigestBoundPaginationOptions<T>,
): DigestBoundPage<T> {
  if (!Number.isSafeInteger(options.maxItems) || options.maxItems < 1) {
    throw new Error("Pagination maxItems must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.maxSerializedBytes) || options.maxSerializedBytes < 2) {
    throw new Error("Pagination maxSerializedBytes must be at least 2");
  }
  const start = options.cursor === undefined
    ? 0
    : decodeCursor(options.cursor, options.digest, options.items.length, options.staleCursorCode);
  const serialize = options.serialize ?? JSON.stringify;
  const upper = Math.min(options.items.length, start + options.maxItems);

  for (let end = upper; end > start; end -= 1) {
    const page = makePage(options.items, options.digest, start, end);
    if (byteLength(serialize(page)) <= options.maxSerializedBytes) return page;
  }

  if (start === options.items.length) {
    const empty = Object.freeze({ items: Object.freeze([]) });
    if (byteLength(serialize(empty)) <= options.maxSerializedBytes) return empty;
    throw new Error("Empty pagination page exceeds the serialized byte limit");
  }
  throw new Error(`Pagination item at index ${start} exceeds the serialized byte limit`);
}

function makePage<T>(
  items: readonly T[],
  digest: string,
  start: number,
  end: number,
): DigestBoundPage<T> {
  const pageItems = Object.freeze(items.slice(start, end));
  return end < items.length
    ? Object.freeze({ items: pageItems, nextCursor: encodeCursor({ v: 1, digest, index: end }) })
    : Object.freeze({ items: pageItems });
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(
  cursor: string,
  expectedDigest: string,
  itemCount: number,
  staleCursorCode: string,
): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new DigestBoundCursorError(staleCursorCode, "Cursor is invalid; restart from the first page");
  }
  if (
    parsed === null
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(",") !== "digest,index,v"
    || !("v" in parsed) || parsed.v !== 1
    || !("digest" in parsed) || parsed.digest !== expectedDigest
    || !("index" in parsed) || !Number.isSafeInteger(parsed.index)
    || (parsed.index as number) < 0 || (parsed.index as number) > itemCount
    || encodeCursor(parsed as CursorPayload) !== cursor
  ) {
    throw new DigestBoundCursorError(staleCursorCode, "Catalog changed or cursor is invalid; restart from the first page");
  }
  return parsed.index as number;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
