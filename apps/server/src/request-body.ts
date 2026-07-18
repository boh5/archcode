import { ServerError } from "./errors";

export interface BoundedJsonBodyOptions {
  readonly maxBytes: number;
  readonly label: string;
}

/** Reads at most maxBytes from the request stream before strict UTF-8 JSON parsing. */
export async function readBoundedJsonBody(
  request: Request,
  options: BoundedJsonBodyOptions,
): Promise<unknown> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new TypeError("Bounded JSON body maxBytes must be a positive safe integer");
  }

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > options.maxBytes) {
      await request.body?.cancel("request body too large").catch(() => undefined);
      throw tooLarge(options);
    }
  }

  if (request.body === null) throw invalidJson(options);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (item.value.byteLength > options.maxBytes - totalBytes) {
        await reader.cancel("request body too large").catch(() => undefined);
        throw tooLarge(options);
      }
      if (item.value.byteLength === 0) continue;
      chunks.push(item.value.slice());
      totalBytes += item.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof ServerError) throw error;
    throw invalidJson(options);
  }
}

function tooLarge(options: BoundedJsonBodyOptions): ServerError {
  return new ServerError(
    "BAD_REQUEST",
    `${options.label} exceeds ${options.maxBytes} bytes`,
    413,
  );
}

function invalidJson(options: BoundedJsonBodyOptions): ServerError {
  return new ServerError(
    "BAD_REQUEST",
    `${options.label} must be valid UTF-8 JSON`,
    400,
  );
}
