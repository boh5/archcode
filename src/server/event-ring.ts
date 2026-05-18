export interface RingEntry {
  id: number;
  event: string;
  data: string;
}

export class EventRing {
  #buffer: RingEntry[] = [];
  #counter = 0;
  readonly capacity: number;

  constructor(capacity: number = 1000) {
    this.capacity = capacity;
  }

  push(eventType: string, data: string): RingEntry {
    this.#counter += 1;
    const entry: RingEntry = {
      id: this.#counter,
      event: eventType,
      data,
    };

    this.#buffer.push(entry);
    if (this.#buffer.length > this.capacity) {
      this.#buffer.shift();
    }

    return entry;
  }

  since(lastId: number): RingEntry[] {
    if (lastId >= this.#counter) {
      return [];
    }

    return this.#buffer.filter((entry) => entry.id > lastId);
  }

  get currentId(): number {
    return this.#counter;
  }
}
