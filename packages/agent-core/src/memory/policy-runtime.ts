import { randomUUID } from "node:crypto";
import type { MemoryPolicy, MemoryPolicyEpoch, MemoryPolicySnapshot } from "@archcode/protocol";

export type { MemoryPolicy, MemoryPolicyEpoch, MemoryPolicySnapshot } from "@archcode/protocol";

export type MemoryApplyAdmission<T> =
  | { readonly status: "admitted"; readonly value: T }
  | { readonly status: "stale"; readonly snapshot: MemoryPolicySnapshot };

export type AutoLearningAdmission =
  | "disabled"
  | "enable_preparing"
  | "enable_pending"
  | "enabled";

export interface MemoryPolicyListener {
  readonly beforeEnable?: () => void | Promise<void>;
  readonly afterEnableFailure?: () => void | Promise<void>;
  readonly afterCommit?: (
    snapshot: MemoryPolicySnapshot,
    previous: MemoryPolicySnapshot,
  ) => void | Promise<void>;
}

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = Object.freeze({
  useMemory: true,
  autoLearning: true,
});

/**
 * Runtime-owned linearization point for Memory policy changes and automatic
 * apply admission. The narrow exclusive gate intentionally covers only the
 * deterministic Memory apply, never extraction or reconciliation LLM work.
 */
export class MemoryPolicyRuntime {
  readonly #bootId: string;
  #current: MemoryPolicySnapshot;
  #enablePhase: "none" | "preparing" | "pending" = "none";
  #gateTail: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<MemoryPolicyListener>();

  constructor(
    initialPolicy: MemoryPolicy = DEFAULT_MEMORY_POLICY,
    bootId: string = randomUUID(),
  ) {
    this.#bootId = bootId;
    this.#current = freezeSnapshot(bootId, 0, initialPolicy);
  }

  get current(): MemoryPolicySnapshot {
    return this.#current;
  }

  get autoLearningAdmission(): AutoLearningAdmission {
    if (this.#current.policy.autoLearning) return "enabled";
    if (this.#enablePhase === "preparing") return "enable_preparing";
    return this.#enablePhase === "pending" ? "enable_pending" : "disabled";
  }

  claim(): MemoryPolicySnapshot {
    return this.#current;
  }

  /** Bootstrap-only replacement within this boot, before automatic work starts. */
  initialize(policy: MemoryPolicy): MemoryPolicySnapshot {
    if (this.#current.epoch.generation !== 0) {
      throw new Error("Memory policy runtime is already active");
    }
    this.#current = freezeSnapshot(this.#bootId, 0, policy);
    return this.#current;
  }

  async publish(policy: MemoryPolicy): Promise<MemoryPolicySnapshot> {
    return await this.commitPolicy(policy, async () => undefined);
  }

  /**
   * Runs the durable Config commit and policy publication under the same gate.
   * A disabling response therefore cannot race an older batch entering apply.
   */
  async commitPolicy(
    policy: MemoryPolicy,
    commit: () => Promise<void>,
  ): Promise<MemoryPolicySnapshot> {
    return await this.#withGate(async () => {
      const previous = this.#current;
      const changed = !samePolicy(previous.policy, policy);
      const enabling = changed
        && !previous.policy.autoLearning
        && policy.autoLearning;
      if (enabling) this.#enablePhase = "preparing";
      try {
        if (enabling) {
          for (const listener of this.#listeners) {
            await listener.beforeEnable?.();
          }
          this.#enablePhase = "pending";
        }
        await commit();
      } catch (error) {
        this.#enablePhase = "none";
        if (enabling) {
          for (const listener of this.#listeners) {
            try {
              await listener.afterEnableFailure?.();
            } catch {
              // The durable commit error remains the authoritative failure.
            }
          }
        }
        throw error;
      }
      if (!changed) return this.#current;
      const next = freezeSnapshot(
        this.#bootId,
        previous.epoch.generation + 1,
        policy,
      );
      this.#current = next;
      this.#enablePhase = "none";
      for (const listener of this.#listeners) {
        await listener.afterCommit?.(next, previous);
      }
      return next;
    });
  }

  async withApplyAdmission<T>(
    expectedEpoch: MemoryPolicyEpoch,
    apply: () => Promise<T>,
  ): Promise<MemoryApplyAdmission<T>> {
    return await this.#withGate(async () => {
      if (
        !this.#current.policy.autoLearning
        || !sameEpoch(this.#current.epoch, expectedEpoch)
      ) {
        return { status: "stale", snapshot: this.#current } as const;
      }
      return { status: "admitted", value: await apply() } as const;
    });
  }

  subscribe(listener: MemoryPolicyListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #withGate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#gateTail;
    let release!: () => void;
    this.#gateTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function freezeSnapshot(
  bootId: string,
  generation: number,
  policy: MemoryPolicy,
): MemoryPolicySnapshot {
  return Object.freeze({
    policy: Object.freeze({
      useMemory: policy.useMemory,
      autoLearning: policy.autoLearning,
    }),
    epoch: Object.freeze({ bootId, generation }),
  });
}

function samePolicy(left: MemoryPolicy, right: MemoryPolicy): boolean {
  return left.useMemory === right.useMemory
    && left.autoLearning === right.autoLearning;
}

function sameEpoch(left: MemoryPolicyEpoch, right: MemoryPolicyEpoch): boolean {
  return left.bootId === right.bootId && left.generation === right.generation;
}
