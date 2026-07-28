interface RootGateState {
  references: number;
  activeUploads: number;
  waitingDeletes: number;
  deleting: boolean;
  waiters: Set<() => void>;
}

/**
 * A small writer-preferring per-root gate. Uploads share a lease; root deletion
 * is exclusive and prevents later uploads from starving it.
 */
export class SessionAttachmentRootGate {
  readonly #states = new Map<string, RootGateState>();

  async withUpload<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const state = this.#state(key);
    try {
      while (state.deleting || state.waitingDeletes > 0) {
        await this.#waitForChange(state);
      }
      state.activeUploads += 1;
      try {
        return await operation();
      } finally {
        state.activeUploads -= 1;
        this.#wake(state);
      }
    } finally {
      this.#releaseState(key, state);
    }
  }

  async withDelete<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const state = this.#state(key);
    try {
      state.waitingDeletes += 1;
      try {
        while (state.deleting || state.activeUploads > 0) {
          await this.#waitForChange(state);
        }
        state.deleting = true;
      } finally {
        state.waitingDeletes -= 1;
      }

      try {
        return await operation();
      } finally {
        state.deleting = false;
        this.#wake(state);
      }
    } finally {
      this.#releaseState(key, state);
    }
  }

  #state(key: string): RootGateState {
    let state = this.#states.get(key);
    if (state === undefined) {
      state = {
        references: 0,
        activeUploads: 0,
        waitingDeletes: 0,
        deleting: false,
        waiters: new Set(),
      };
      this.#states.set(key, state);
    }
    state.references += 1;
    return state;
  }

  #waitForChange(state: RootGateState): Promise<void> {
    return new Promise<void>((resolve) => state.waiters.add(resolve));
  }

  #wake(state: RootGateState): void {
    const waiters = [...state.waiters];
    state.waiters.clear();
    for (const resolve of waiters) resolve();
  }

  #releaseState(key: string, state: RootGateState): void {
    state.references -= 1;
    if (
      state.references === 0
      && state.activeUploads === 0
      && state.waitingDeletes === 0
      && !state.deleting
      && state.waiters.size === 0
    ) {
      this.#states.delete(key);
    }
  }
}

export class AsyncKeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tails.set(key, current);
    await predecessor.catch(() => undefined);

    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(key) === current) this.#tails.delete(key);
    }
  }
}
