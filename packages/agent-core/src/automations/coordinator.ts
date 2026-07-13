/** Serializes control and dispatch decisions for one Automation. */
export class AutomationCoordinator {
  readonly #tails = new Map<string, Promise<void>>();

  async runExclusive<T>(automationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(automationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.#tails.set(automationId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(automationId) === tail) this.#tails.delete(automationId);
    }
  }
}
