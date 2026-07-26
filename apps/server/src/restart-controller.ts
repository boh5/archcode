import { UpdateError } from "./updater";

export interface RestartRequestScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
}

const systemRestartScheduler: RestartRequestScheduler = {
  schedule(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
};

/**
 * One-shot bridge between an HTTP restart request and the process lifecycle.
 * Binding happens only after the listener is live, so accepted requests always
 * have a concrete graceful-shutdown target.
 */
export class ServerRestartController {
  readonly #scheduler: RestartRequestScheduler;
  #handler: (() => Promise<void>) | undefined;
  #requested = false;

  constructor(scheduler: RestartRequestScheduler = systemRestartScheduler) {
    this.#scheduler = scheduler;
  }

  bind(handler: () => Promise<void>): () => void {
    if (this.#handler !== undefined) {
      throw new Error("Server restart controller is already bound");
    }
    this.#handler = handler;
    return () => {
      if (this.#handler === handler) this.#handler = undefined;
    };
  }

  request(): void {
    if (this.#handler === undefined) {
      throw new UpdateError(
        "UPDATE_RESTART_UNAVAILABLE",
        "This ArchCode process cannot restart itself",
      );
    }
    if (this.#requested) return;
    this.#requested = true;
    const handler = this.#handler;
    this.#scheduler.schedule(() => {
      void handler();
    }, 100);
  }
}
