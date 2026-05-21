import type { GlobalSSEEvent } from "@specra/protocol";

export type GlobalEventBusListener = (event: GlobalSSEEvent) => void;

export class GlobalEventBus {
  readonly #listeners = new Set<GlobalEventBusListener>();

  subscribe(listener: GlobalEventBusListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(event: GlobalSSEEvent): void {
    for (const listener of [...this.#listeners]) {
      listener(event);
    }
  }
}

export const globalEventBus = new GlobalEventBus();
