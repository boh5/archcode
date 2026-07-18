import type { ArchCodeConfig } from "../config";
import { createRegistry } from "../provider";
import { ModelRuntimeSnapshot } from "./model-runtime-snapshot";

/**
 * The sole mutable pointer for model configuration used when claiming new
 * Executions. Prepared snapshots are complete and immutable before publish.
 */
export class ModelRuntime {
  #current: ModelRuntimeSnapshot | undefined;
  readonly #listeners = new Set<(snapshot: ModelRuntimeSnapshot) => void>();

  get current(): ModelRuntimeSnapshot {
    if (!this.#current) {
      throw new ModelRuntimeNotPublishedError();
    }
    return this.#current;
  }

  get revision(): string | undefined {
    return this.#current?.revision;
  }

  /** Build a fully usable snapshot without mutating the current pointer. */
  prepare(config: ArchCodeConfig, revision: string): ModelRuntimeSnapshot {
    const detachedConfig = structuredClone(config);
    const providerRegistry = createRegistry(detachedConfig.provider);
    return new ModelRuntimeSnapshot({ revision, config: detachedConfig, providerRegistry });
  }

  /** Synchronous pointer replacement; all failure-prone work belongs in prepare. */
  publish(snapshot: ModelRuntimeSnapshot): void {
    const previousRevision = this.#current?.revision;
    this.#current = snapshot;
    if (snapshot.revision === previousRevision) return;
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch {
        // Publication is the atomic configuration commit point. A control-plane
        // observer cannot turn an already-published snapshot into a failed save.
      }
    }
  }

  subscribe(listener: (snapshot: ModelRuntimeSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

}

export class ModelRuntimeNotPublishedError extends Error {
  constructor() {
    super("Model runtime has not been published yet.");
    this.name = "ModelRuntimeNotPublishedError";
  }
}
