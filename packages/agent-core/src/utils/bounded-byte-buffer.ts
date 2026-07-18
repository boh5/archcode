/** Geometrically-grown byte accumulator with a fixed hard ceiling. */
export class BoundedByteBuffer {
  #buffer: Uint8Array;
  #length = 0;

  constructor(
    readonly maxBytes: number,
    initialBytes = 4 * 1024,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new TypeError("BoundedByteBuffer maxBytes must be a non-negative safe integer");
    }
    const capacity = Math.min(maxBytes, Math.max(0, initialBytes));
    this.#buffer = new Uint8Array(capacity);
  }

  get byteLength(): number {
    return this.#length;
  }

  append(chunk: Uint8Array): boolean {
    if (chunk.byteLength > this.maxBytes - this.#length) return false;
    this.#ensureCapacity(this.#length + chunk.byteLength);
    this.#buffer.set(chunk, this.#length);
    this.#length += chunk.byteLength;
    return true;
  }

  bytes(): Uint8Array {
    return this.#buffer.subarray(0, this.#length);
  }

  #ensureCapacity(required: number): void {
    if (required <= this.#buffer.byteLength) return;
    let capacity = Math.max(1, this.#buffer.byteLength);
    while (capacity < required) {
      capacity = Math.min(this.maxBytes, Math.max(required, capacity * 2));
    }
    const grown = new Uint8Array(capacity);
    grown.set(this.#buffer.subarray(0, this.#length));
    this.#buffer = grown;
  }
}
