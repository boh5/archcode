import { watch, type FSWatcher } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Logger } from "../logger";
import { ReviewableSourceSet } from "./reviewable-source";

interface ReviewWatchHandle {
  close(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
}

type ReviewWatchFactory = (
  directory: string,
  options: { readonly recursive: boolean },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => ReviewWatchHandle;

let watchFactoryForTest: ReviewWatchFactory | undefined;
let pathClassifierForTest: ((sources: ReviewableSourceSet, path: string) => Promise<boolean>) | undefined;

/** Test seam for deterministic watch allocation and event delivery. */
export function setSessionGoalReviewWatchFactoryForTest(factory: ReviewWatchFactory | undefined): void {
  watchFactoryForTest = factory;
}

/** Test seam for holding path classification across terminal cleanup. */
export function setSessionGoalReviewPathClassifierForTest(
  classifier: ((sources: ReviewableSourceSet, path: string) => Promise<boolean>) | undefined,
): void {
  pathClassifierForTest = classifier;
}

/**
 * One short-lived review-attempt monitor. It uses Bun's in-process node:fs
 * surface so compiled ArchCode needs no external Node runtime. Native events
 * are the admission condition; metadata is only an additional write-and-
 * restore fence after every required directory watcher exists.
 */
export class SessionGoalReviewSourceMonitor {
  readonly #watchers = new Map<string, ReviewWatchHandle>();
  readonly #pendingPathEvents = new Set<Promise<void>>();
  #closed = false;
  #disposal?: Promise<void>;
  #mutation?: Promise<void>;
  #invalidationReason?: string;
  #metadataSnapshot = new Map<string, string>();

  private constructor(private readonly input: {
    readonly cwd: string;
    readonly sources: ReviewableSourceSet;
    readonly onSourceMutation: () => Promise<void>;
    readonly logger: Logger;
  }) {}

  static async start(input: {
    readonly cwd: string;
    readonly onSourceMutation: () => Promise<void>;
    readonly logger: Logger;
  }): Promise<SessionGoalReviewSourceMonitor> {
    const cwd = resolve(input.cwd);
    const monitor = new SessionGoalReviewSourceMonitor({
      ...input,
      cwd,
      sources: await ReviewableSourceSet.create(cwd),
    });
    try {
      // Capture source metadata before allocating watches. This is a second
      // fence for write-and-restore changes while watchers are being installed;
      // path events remain the authority for transient new files, so ignored
      // cache-directory timestamps never affect a review.
      monitor.#metadataSnapshot = await captureReviewableMetadata(cwd, monitor.input.sources);
    } catch (error) {
      monitor.#invalidate("metadata_snapshot_start_failed", error);
      return monitor;
    }
    await monitor.#startWatches();
    if (monitor.#mutation !== undefined) return monitor;
    try {
      const afterWatchStart = await captureReviewableMetadata(cwd, monitor.input.sources);
      if (!sameMetadata(monitor.#metadataSnapshot, afterWatchStart)) {
        monitor.#invalidate("metadata_changed_during_watch_start");
      } else {
        monitor.#metadataSnapshot = afterWatchStart;
      }
    } catch (error) {
      monitor.#invalidate("metadata_snapshot_after_watch_start_failed", error);
    }
    return monitor;
  }

  get isWatching(): boolean {
    return !this.#closed && this.#watchers.size > 0;
  }

  get invalidationReason(): string | undefined {
    return this.#invalidationReason;
  }

  dispose(): Promise<void> {
    this.#disposal ??= this.#dispose();
    return this.#disposal;
  }

  async #dispose(): Promise<void> {
    this.#closed = true;
    this.#closeWatchers();

    // Closing the native handles prevents new admission, but a callback that
    // already entered may still be awaiting Git ignore classification. Drain
    // every admitted event before the terminal metadata fence and review
    // settlement. Otherwise a transient create/delete can be classified only
    // after its claim has already completed and can no longer be invalidated.
    await Promise.all([...this.#pendingPathEvents]);

    if (this.#mutation === undefined) {
      try {
        const current = await captureReviewableMetadata(this.input.cwd, await ReviewableSourceSet.create(this.input.cwd));
        if (!sameMetadata(this.#metadataSnapshot, current)) this.#invalidate("metadata_snapshot_changed");
      } catch (error) {
        this.#invalidate("metadata_snapshot_end_failed", error);
      }
    }
    await this.#mutation;
  }

  async #startWatches(): Promise<void> {
    // A single recursive watch establishes the strongest possible admission
    // fence: it is active before any per-directory enumeration can race with
    // a source change. Bun supports this through its node:fs surface on the
    // platforms where the underlying watcher can provide it.
    try {
      this.#addWatcher(this.input.cwd, true);
      return;
    } catch (error) {
      this.#closeWatchers();
      if (!isRecursiveWatchUnsupported(error)) {
        this.#invalidate("watch_allocation_failed", error);
        return;
      }
    }

    // Some platforms lack recursive watching. Watch every reviewable
    // directory instead; a new non-ignored directory is conservatively a
    // source event at its watched parent and invalidates the review.
    let directories: readonly string[];
    try {
      directories = await this.input.sources.listWatchDirectories();
    } catch (error) {
      this.#invalidate("watch_directory_enumeration_failed", error);
      return;
    }
    for (const directory of directories) {
      if (this.#closed || this.#mutation !== undefined) return;
      try {
        this.#addWatcher(directory, false);
      } catch (error) {
        this.#invalidate("watch_allocation_failed", error);
        return;
      }
    }
    if (this.#watchers.size === 0) this.#invalidate("watch_allocation_failed");
  }

  #addWatcher(directory: string, recursive: boolean): void {
    const watcher = (watchFactoryForTest ?? defaultWatchFactory)(directory, { recursive }, (eventType, filename) => {
      this.#onWatchEvent(directory, eventType, filename);
    });
    watcher.on("error", (error) => this.#invalidate("watch_error", error));
    this.#watchers.set(directory, watcher);
    // A deterministic test seam (or an unusual host implementation) may
    // deliver an event synchronously during allocation. Do not retain the
    // just-created handle after that event has already invalidated the claim.
    if (this.#mutation !== undefined) {
      this.#watchers.delete(directory);
      watcher.close();
    }
  }

  #onWatchEvent(directory: string, _eventType: string, filename: string | Buffer | null): void {
    if (this.#closed || this.#mutation !== undefined) return;
    if (filename === null) {
      this.#invalidate("filename_unavailable");
      return;
    }
    const value = filename.toString();
    const absolute = isAbsolute(value) ? value : resolve(directory, value);
    const path = relative(this.input.cwd, absolute);
    const operation = this.#handlePathEvent(path).catch((error) => {
      // #handlePathEvent is deliberately fail-closed. Keep this final guard at
      // the admission boundary so an unexpected implementation error can
      // neither leak an unhandled rejection nor permit review completion.
      this.#invalidate("reviewed_path_classification_failed", error);
    });
    this.#pendingPathEvents.add(operation);
    void operation.then(() => {
      this.#pendingPathEvents.delete(operation);
    });
  }

  async #handlePathEvent(path: string): Promise<void> {
    if (this.#closed || this.#mutation !== undefined) return;
    try {
      const containsEventPath = pathClassifierForTest ?? (
        (sources: ReviewableSourceSet, candidate: string) => sources.containsEventPath(candidate)
      );
      if (!await containsEventPath(this.input.sources, path)) return;
      this.#invalidate("source_event");
    } catch (error) {
      this.#invalidate("reviewed_path_classification_failed", error);
    }
  }

  #invalidate(reason: string, error?: unknown): void {
    if (this.#mutation !== undefined) return;
    this.#invalidationReason = reason;
    this.#closeWatchers();
    this.#mutation = this.input.onSourceMutation().catch((mutationError) => {
      this.input.logger.warn("session-goal.review-source-monitor.invalidate_failed", {
        error: mutationError,
        context: { cwd: this.input.cwd, reason },
      });
    });
    this.input.logger.warn("session-goal.review-source-monitor.invalidated", {
      ...(error === undefined ? {} : { error }),
      context: { cwd: this.input.cwd, reason },
    });
  }

  #closeWatchers(): void {
    for (const watcher of this.#watchers.values()) {
      try {
        watcher.close();
      } catch {
        // Repeated close is harmless during concurrent terminal cleanup.
      }
    }
    this.#watchers.clear();
  }
}

async function captureReviewableMetadata(root: string, sources: ReviewableSourceSet): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const path of sources.paths) {
    try {
      const stat = await lstat(join(root, path));
      result.set(path, [stat.mode, stat.size, stat.ctimeMs, stat.isSymbolicLink() ? "l" : stat.isDirectory() ? "d" : "f"].join(":"));
    } catch (error) {
      if (isMissing(error)) result.set(path, "missing");
      else throw error;
    }
  }
  return result;
}

function sameMetadata(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [path, value] of left) if (right.get(path) !== value) return false;
  return true;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecursiveWatchUnsupported(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message) : "";
  return code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"
    || /recursive.*(unsupported|unavailable)|recursive watch/i.test(message);
}

const defaultWatchFactory: ReviewWatchFactory = (directory, options, listener): FSWatcher => (
  watch(directory, { persistent: false, encoding: "utf8", recursive: options.recursive }, listener)
);
