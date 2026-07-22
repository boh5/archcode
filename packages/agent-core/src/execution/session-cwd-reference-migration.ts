import { rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { projectRuntimePath } from "../projects/runtime-path";
import { SessionCwdReferenceMigrationError } from "../store/errors";
import { atomicWrite, isContained } from "../utils/safe-file";
import {
  SessionStoreManager,
  type SessionCwdPathBarrierLease,
  type SessionCwdReference,
} from "../store/session-store-manager";

export interface SessionCwdReferenceMigrationServiceOptions {
  readonly storeManager: SessionStoreManager;
  readonly acquireIdleSessionFamilyCwdTransitions: (
    projectRoot: string,
    rootSessionIds: readonly string[],
  ) => () => void;
  readonly releaseSessionAgent?: (projectRoot: string, sessionId: string) => void;
}

export interface SessionCwdReferenceMigrationInput {
  readonly projectRoot: string;
  readonly fromCwd: string;
  readonly toCwd: string;
}

export interface SessionCwdRemovalResult {
  readonly removed: boolean;
}

/**
 * Generic removal lifecycle capabilities. The worktree layer invokes them
 * while it owns its repository lifecycle lock; it never needs Session types.
 */
export interface SessionCwdRemovalLifecycle {
  /** Migrates every durable reference after final worktree validation. */
  readonly beforeRemove: () => Promise<void>;
  /** Rolls migration back only when the detach command itself failed. */
  readonly onRemoveFailureBeforeDetach: () => Promise<void>;
  /** Commits migration as irreversible immediately after detach succeeds. */
  readonly onRemoveDetached: () => Promise<void>;
}

type SessionCwdMigrationPhase = "prepared" | "migrating" | "migrated" | "detached" | "rolling_back";

interface SessionCwdMigrationJournal {
  readonly projectRoot: string;
  readonly fromCwd: string;
  readonly toCwd: string;
  readonly phase: SessionCwdMigrationPhase;
  readonly references: readonly SessionCwdReference[];
}

/**
 * Coordinates the cross-resource boundary between durable Session cwd state
 * and removal of an execution worktree. Session storage owns reference
 * discovery/CAS; the execution layer owns root-family quiescence; callers only
 * receive lifecycle capabilities and never inspect Session files directly.
 */
export class SessionCwdReferenceMigrationService {
  readonly #storeManager: SessionStoreManager;
  readonly #acquireIdleSessionFamilyCwdTransitions: SessionCwdReferenceMigrationServiceOptions["acquireIdleSessionFamilyCwdTransitions"];
  readonly #releaseSessionAgent?: SessionCwdReferenceMigrationServiceOptions["releaseSessionAgent"];

  constructor(options: SessionCwdReferenceMigrationServiceOptions) {
    this.#storeManager = options.storeManager;
    this.#acquireIdleSessionFamilyCwdTransitions = options.acquireIdleSessionFamilyCwdTransitions;
    this.#releaseSessionAgent = options.releaseSessionAgent;
  }

  async migrateForRemoval<T extends SessionCwdRemovalResult>(
    input: SessionCwdReferenceMigrationInput,
    operation: (lifecycle: SessionCwdRemovalLifecycle) => Promise<T>,
  ): Promise<T> {
    this.#assertInput(input);
    const barrier = this.#storeManager.acquireCwdPathBarrier(input.fromCwd);
    let releaseFamilies: (() => void) | undefined;
    let journal = await this.#readJournal(input);
    const migrated: SessionCwdReference[] = journal === undefined ? [] : [...journal.references];
    let beforeRemoveCalled = false;
    let rollbackAttempted = false;
    let rollbackCompleted = false;
    let removeDetached = false;

    try {
      if (journal?.phase === "rolling_back") {
        await this.#loadReferences(input.projectRoot, journal.references);
      }
      const initialReferences = await this.#storeManager.scanCwdReferencesStrict(input.projectRoot, input.fromCwd);
      const knownReferences = mergeReferences(journal?.references ?? [], initialReferences);
      await this.#loadReferences(input.projectRoot, knownReferences);
      const rootSessionIds = uniqueSorted(knownReferences.map((reference) => reference.rootSessionId));
      releaseFamilies = this.#acquireIdleSessionFamilyCwdTransitions(input.projectRoot, rootSessionIds);
      const leasedRoots = new Set(rootSessionIds);

      if (journal?.phase === "rolling_back") {
        await this.#rollback(input, barrier, migrated);
        await this.#deleteJournal(input);
        journal = undefined;
      }

      const referencesUnderLease = await this.#storeManager.scanCwdReferencesStrict(input.projectRoot, input.fromCwd);
      this.#assertReferencesCovered(input, referencesUnderLease, leasedRoots);
      await this.#loadReferences(input.projectRoot, referencesUnderLease);

      if (journal === undefined) {
        journal = {
          projectRoot: resolve(input.projectRoot),
          fromCwd: resolve(input.fromCwd),
          toCwd: resolve(input.toCwd),
          phase: "prepared",
          references: referencesUnderLease,
        };
        await this.#writeJournal(input, journal);
      }

      const beforeRemove = async (): Promise<void> => {
        if (beforeRemoveCalled) {
          throw new SessionCwdReferenceMigrationError(
            input.fromCwd,
            input.toCwd,
            "Session cwd before-remove capability can only be used once",
          );
        }
        beforeRemoveCalled = true;
        if (journal?.phase === "detached") return;
        try {
          const latest = await this.#storeManager.scanCwdReferencesStrict(input.projectRoot, input.fromCwd);
          this.#assertReferencesCovered(input, latest, leasedRoots);
          await this.#loadReferences(input.projectRoot, latest);

          const references = mergeReferences(journal?.references ?? [], latest);
          journal = {
            projectRoot: resolve(input.projectRoot),
            fromCwd: resolve(input.fromCwd),
            toCwd: resolve(input.toCwd),
            phase: "migrating",
            references,
          };
          await this.#writeJournal(input, journal);

          for (const reference of latest) {
            await this.#storeManager.updateCwdForMigration(
              reference.sessionId,
              input.projectRoot,
              input.toCwd,
              reference.cwd,
              barrier,
            );
            migrated.push(reference);
            this.#releaseSessionAgent?.(input.projectRoot, reference.sessionId);
          }

          const remaining = await this.#storeManager.scanCwdReferencesStrict(input.projectRoot, input.fromCwd);
          if (remaining.length > 0) {
            throw new SessionCwdReferenceMigrationError(
              input.fromCwd,
              input.toCwd,
              `Session cwd references remained after migration: ${remaining.map((reference) => reference.sessionId).join(", ")}`,
            );
          }
          journal = { ...journal, phase: "migrated" };
          await this.#writeJournal(input, journal);
        } catch (error) {
          rollbackAttempted = true;
          try {
            if (journal !== undefined) {
              journal = { ...journal, phase: "rolling_back" };
              await this.#writeJournal(input, journal);
            }
            await this.#rollback(input, barrier, migrated);
            rollbackCompleted = true;
            await this.#deleteJournal(input);
            journal = undefined;
          } catch (rollbackError) {
            throw new SessionCwdReferenceMigrationError(
              input.fromCwd,
              input.toCwd,
              "Session cwd migration failed and could not be rolled back before worktree removal",
              new AggregateError([error, rollbackError]),
            );
          }
          throw error;
        }
      };

      const onRemoveFailureBeforeDetach = async (): Promise<void> => {
        if (!beforeRemoveCalled || removeDetached || rollbackAttempted) {
          throw this.#contractError(input, "Invalid pre-detach removal failure callback ordering");
        }
        rollbackAttempted = true;
        try {
          if (journal !== undefined) {
            journal = { ...journal, phase: "rolling_back" };
            await this.#writeJournal(input, journal);
          }
          await this.#rollback(input, barrier, migrated);
          rollbackCompleted = true;
          await this.#deleteJournal(input);
          journal = undefined;
        } catch (rollbackError) {
          throw new SessionCwdReferenceMigrationError(
            input.fromCwd,
            input.toCwd,
            "Unable to roll back Session cwd migration after worktree detach failed",
            rollbackError,
          );
        }
      };

      const onRemoveDetached = async (): Promise<void> => {
        if (!beforeRemoveCalled || removeDetached || rollbackAttempted) {
          throw this.#contractError(input, "Invalid worktree-detached callback ordering");
        }
        removeDetached = true;
        if (journal !== undefined) {
          journal = { ...journal, phase: "detached" };
          await this.#writeJournal(input, journal);
        }
      };

      let result: T;
      try {
        result = await operation({ beforeRemove, onRemoveFailureBeforeDetach, onRemoveDetached });
      } catch (error) {
        if (beforeRemoveCalled && !removeDetached && !rollbackAttempted) {
          throw this.#contractError(
            input,
            "Removal failed before detach without invoking the rollback capability",
            error,
          );
        }
        throw error;
      }
      if (result.removed && (!beforeRemoveCalled || !removeDetached)) {
        throw new SessionCwdReferenceMigrationError(
          input.fromCwd,
          input.toCwd,
          "Removal completed without invoking the complete Session cwd removal lifecycle",
        );
      }
      if (result.removed) {
        await this.#deleteJournal(input);
        journal = undefined;
      }
      if (!result.removed && beforeRemoveCalled && !removeDetached && !rollbackCompleted) {
        throw this.#contractError(input, "Removal returned before detach without invoking the rollback capability");
      }
      if (!result.removed && journal !== undefined) {
        if (journal.phase === "migrating" || journal.phase === "migrated") {
          journal = { ...journal, phase: "rolling_back" };
          await this.#writeJournal(input, journal);
          await this.#rollback(input, barrier, migrated);
        }
        await this.#deleteJournal(input);
        journal = undefined;
      }
      return result;
    } finally {
      try {
        releaseFamilies?.();
      } finally {
        barrier.release();
      }
    }
  }

  async __journalPathForTest(input: SessionCwdReferenceMigrationInput): Promise<string> {
    this.#assertInput(input);
    return this.#journalPath(input);
  }

  async #loadReferences(projectRoot: string, references: readonly SessionCwdReference[]): Promise<void> {
    const rootSessionIds = uniqueSorted(references.map((reference) => reference.rootSessionId));
    for (const rootSessionId of rootSessionIds) await this.#storeManager.getOrLoad(rootSessionId, projectRoot);
    for (const sessionId of uniqueSorted(references.map((reference) => reference.sessionId))) {
      await this.#storeManager.getOrLoad(sessionId, projectRoot);
    }
  }

  #assertReferencesCovered(
    input: SessionCwdReferenceMigrationInput,
    references: readonly SessionCwdReference[],
    leasedRoots: ReadonlySet<string>,
  ): void {
    const uncovered = uniqueSorted(
      references
        .map((reference) => reference.rootSessionId)
        .filter((rootSessionId) => !leasedRoots.has(rootSessionId)),
    );
    if (uncovered.length === 0) return;
    throw new SessionCwdReferenceMigrationError(
      input.fromCwd,
      input.toCwd,
      `New Session root families appeared after cleanup leasing: ${uncovered.join(", ")}`,
    );
  }

  async #rollback(
    input: SessionCwdReferenceMigrationInput,
    barrier: SessionCwdPathBarrierLease,
    migrated: SessionCwdReference[],
  ): Promise<void> {
    while (migrated.length > 0) {
      const reference = migrated[migrated.length - 1]!;
      const store = await this.#storeManager.getOrLoad(reference.sessionId, input.projectRoot);
      const currentCwd = store.getState().cwd;
      if (resolve(currentCwd) !== resolve(input.fromCwd)) {
        await this.#storeManager.updateCwdForMigration(
          reference.sessionId,
          input.projectRoot,
          input.fromCwd,
          input.toCwd,
          barrier,
        );
        this.#releaseSessionAgent?.(input.projectRoot, reference.sessionId);
      }
      migrated.pop();
    }
  }

  #contractError(
    input: SessionCwdReferenceMigrationInput,
    message: string,
    cause?: unknown,
  ): SessionCwdReferenceMigrationError {
    return new SessionCwdReferenceMigrationError(
      input.fromCwd,
      input.toCwd,
      `Session cwd removal lifecycle contract violated: ${message}`,
      cause,
    );
  }

  #assertInput(input: SessionCwdReferenceMigrationInput): void {
    if (!isAbsolute(input.projectRoot) || !isAbsolute(input.fromCwd) || !isAbsolute(input.toCwd)) {
      throw new SessionCwdReferenceMigrationError(
        input.fromCwd,
        input.toCwd,
        "Session cwd reference migration requires absolute paths",
      );
    }
    if (resolve(input.fromCwd) === resolve(input.toCwd)) {
      throw new SessionCwdReferenceMigrationError(
        input.fromCwd,
        input.toCwd,
        "Session cwd reference migration source and destination must differ",
      );
    }
  }

  async #readJournal(input: SessionCwdReferenceMigrationInput): Promise<SessionCwdMigrationJournal | undefined> {
    const file = Bun.file(this.#journalPath(input));
    if (!await file.exists()) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(await file.text());
    } catch (error) {
      throw new SessionCwdReferenceMigrationError(input.fromCwd, input.toCwd, "Invalid Session cwd migration journal", error);
    }
    if (!isMigrationJournal(value)
      || resolve(value.projectRoot) !== resolve(input.projectRoot)
      || resolve(value.fromCwd) !== resolve(input.fromCwd)
      || resolve(value.toCwd) !== resolve(input.toCwd)) {
      throw new SessionCwdReferenceMigrationError(input.fromCwd, input.toCwd, "Session cwd migration journal does not match the requested removal");
    }
    return value;
  }

  async #writeJournal(input: SessionCwdReferenceMigrationInput, journal: SessionCwdMigrationJournal): Promise<void> {
    await atomicWrite(this.#journalPath(input), `${JSON.stringify(journal, null, 2)}\n`);
  }

  async #deleteJournal(input: SessionCwdReferenceMigrationInput): Promise<void> {
    await rm(this.#journalPath(input), { force: true });
  }

  #journalPath(input: SessionCwdReferenceMigrationInput): string {
    const digest = new Bun.CryptoHasher("sha256").update(resolve(input.fromCwd)).digest("hex");
    const root = projectRuntimePath(input.projectRoot, "session-cwd-migrations");
    const path = resolve(root, `${digest}.json`);
    if (!isContained(path, root)) throw this.#contractError(input, "Migration journal path escaped project state");
    return path;
  }
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function mergeReferences(
  left: readonly SessionCwdReference[],
  right: readonly SessionCwdReference[],
): SessionCwdReference[] {
  const references = new Map<string, SessionCwdReference>();
  for (const reference of [...left, ...right]) references.set(reference.sessionId, reference);
  return [...references.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

function isMigrationJournal(value: unknown): value is SessionCwdMigrationJournal {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ["projectRoot", "fromCwd", "toCwd", "phase", "references"])
    || typeof record.projectRoot !== "string"
    || typeof record.fromCwd !== "string"
    || typeof record.toCwd !== "string"
    || !["prepared", "migrating", "migrated", "detached", "rolling_back"].includes(String(record.phase))
    || !Array.isArray(record.references)) return false;
  return record.references.every((reference) => {
    if (typeof reference !== "object" || reference === null) return false;
    const item = reference as Record<string, unknown>;
    return hasExactKeys(item, ["sessionId", "rootSessionId", "cwd"])
      && typeof item.sessionId === "string"
      && typeof item.rootSessionId === "string"
      && typeof item.cwd === "string";
  });
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(record, key));
}
