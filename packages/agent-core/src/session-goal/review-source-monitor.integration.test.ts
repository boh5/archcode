import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "../logger";
import { computeSourceFingerprint } from "./source-fingerprint";
import {
  SessionGoalReviewSourceMonitor,
  setSessionGoalReviewPathClassifierForTest,
  setSessionGoalReviewWatchFactoryForTest,
} from "./review-source-monitor";

const root = join(tmpdir(), "archcode-review-monitor-" + crypto.randomUUID());
const watches: FakeWatch[] = [];

afterEach(async () => {
  setSessionGoalReviewWatchFactoryForTest(undefined);
  setSessionGoalReviewPathClassifierForTest(undefined);
  watches.splice(0);
  await rm(root, { recursive: true, force: true });
});

describe("SessionGoalReviewSourceMonitor", () => {
  beforeEach(() => {
    setSessionGoalReviewWatchFactoryForTest((_directory, _options, listener) => {
      const watcher = new FakeWatch(listener);
      watches.push(watcher);
      return watcher;
    });
  });

  test("non-Git build output write-and-restore invalidates despite an identical final fingerprint", async () => {
    const source = join(root, "dist", "app.js");
    const original = "export const value = 1;\n";
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(source, original);
    const before = await computeSourceFingerprint(root);
    let mutations = 0;
    const monitor = await SessionGoalReviewSourceMonitor.start({
      cwd: root,
      logger: silentLogger,
      onSourceMutation: async () => { mutations += 1; },
    });

    await writeAndRestore(source, original);
    expect(await Bun.file(source).text()).toBe(original);
    expect(await computeSourceFingerprint(root)).toBe(before);
    await monitor.dispose();

    expect(mutations).toBe(1);
    expect(["source_event", "metadata_snapshot_changed"]).toContain(monitor.invalidationReason ?? "");
  });

  test("tracked Git dist remains reviewable while a custom ignored cache does not invalidate", async () => {
    const source = join(root, "dist", "app.js");
    const original = "export const value = 1;\n";
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "dist/\ncache/\n");
    await writeFile(source, original);
    await git(["init"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await git(["add", ".gitignore"]);
    await git(["add", "-f", "dist/app.js"]);
    await git(["commit", "-m", "seed"]);

    let trackedMutations = 0;
    const trackedMonitor = await SessionGoalReviewSourceMonitor.start({
      cwd: root,
      logger: silentLogger,
      onSourceMutation: async () => { trackedMutations += 1; },
    });
    await writeAndRestore(source, original);
    await trackedMonitor.dispose();
    expect(trackedMutations).toBe(1);

    let ignoredMutations = 0;
    const ignoredMonitor = await SessionGoalReviewSourceMonitor.start({
      cwd: root,
      logger: silentLogger,
      onSourceMutation: async () => { ignoredMutations += 1; },
    });
    await mkdir(join(root, "cache"), { recursive: true });
    await writeFile(join(root, "cache", "result.json"), "{}\n");
    await ignoredMonitor.dispose();
    expect(ignoredMutations).toBe(0);
  });

  test("cleanup stops observation and fixed ArchCode control state stays outside the review set", async () => {
    await mkdir(join(root, ".archcode"), { recursive: true });
    await writeFile(join(root, "source.ts"), "export {};\n");
    let mutations = 0;
    const monitor = await SessionGoalReviewSourceMonitor.start({
      cwd: root,
      logger: silentLogger,
      onSourceMutation: async () => { mutations += 1; },
    });

    await writeFile(join(root, ".archcode", "runtime.json"), "{}\n");
    await monitor.dispose();
    expect(mutations).toBe(0);
    await writeFile(join(root, "source.ts"), "export const afterDispose = true;\n");
    await Bun.sleep(100);
    expect(mutations).toBe(0);
    expect(monitor.isWatching).toBe(false);
  });

  test("watch allocation failure invalidates before create-and-delete can escape review", async () => {
    await mkdir(root, { recursive: true });
    const source = join(root, "source.ts");
    await writeFile(source, "export {};\n");
    const before = await computeSourceFingerprint(root);
    let mutations = 0;
    setSessionGoalReviewWatchFactoryForTest(() => {
      throw new Error("watch unavailable");
    });

    const monitor = await SessionGoalReviewSourceMonitor.start({
      cwd: root,
      logger: silentLogger,
      onSourceMutation: async () => { mutations += 1; },
    });
    const transient = join(root, "created-then-deleted.ts");
    await writeFile(transient, "temporary\n");
    await unlink(transient);
    expect(await computeSourceFingerprint(root)).toBe(before);

    await monitor.dispose();
    expect(mutations).toBe(1);
    expect(monitor.invalidationReason).toBe("watch_allocation_failed");
    expect(monitor.isWatching).toBe(false);
  });

  test("a transient non-ignored source event invalidates even when the final tree is identical", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "source.ts"), "export {};\n");
    const before = await computeSourceFingerprint(root);
    let mutations = 0;
    const monitor = await SessionGoalReviewSourceMonitor.start({
      cwd: root,
      logger: silentLogger,
      onSourceMutation: async () => { mutations += 1; },
    });

    const transient = join(root, "created-then-deleted.ts");
    await writeFile(transient, "temporary\n");
    await unlink(transient);
    watches[0]!.emit("rename", "created-then-deleted.ts");
    expect(await computeSourceFingerprint(root)).toBe(before);

    await monitor.dispose();
    expect(mutations).toBe(1);
    expect(monitor.invalidationReason).toBe("source_event");
    expect(monitor.isWatching).toBe(false);
  });

  test("terminal cleanup drains an admitted path classification before review settlement", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "source.ts"), "export {};\n");
    const classification = deferred<boolean>();
    const mutation = deferred<void>();
    let classifications = 0;
    let mutations = 0;
    setSessionGoalReviewPathClassifierForTest(async () => {
      classifications += 1;
      return await classification.promise;
    });
    const monitor = await SessionGoalReviewSourceMonitor.start({
      cwd: root,
      logger: silentLogger,
      onSourceMutation: async () => {
        mutations += 1;
        await mutation.promise;
      },
    });

    watches[0]!.emit("rename", "created-then-deleted.ts");
    expect(classifications).toBe(1);
    let disposed = false;
    const disposal = monitor.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);

    classification.resolve(true);
    await waitFor(() => mutations === 1);
    expect(disposed).toBe(false);
    expect(monitor.invalidationReason).toBe("source_event");
    mutation.resolve();
    await disposal;

    expect(disposed).toBe(true);
    expect(mutations).toBe(1);
    watches[0]!.emit("rename", "late.ts");
    expect(classifications).toBe(1);
  });

  test("classifier rejection and concurrent cleanup fail closed without duplicate mutation", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "source.ts"), "export {};\n");
    const classification = deferred<boolean>();
    let mutations = 0;
    setSessionGoalReviewPathClassifierForTest(async () => await classification.promise);
    const monitor = await SessionGoalReviewSourceMonitor.start({
      cwd: root,
      logger: silentLogger,
      onSourceMutation: async () => { mutations += 1; },
    });

    watches[0]!.emit("rename", "ambiguous.ts");
    const firstCleanup = monitor.dispose();
    const secondCleanup = monitor.dispose();
    classification.reject(new Error("injected classification failure"));

    await expect(Promise.all([firstCleanup, secondCleanup])).resolves.toEqual([undefined, undefined]);
    expect(mutations).toBe(1);
    expect(monitor.invalidationReason).toBe("reviewed_path_classification_failed");
    expect(monitor.isWatching).toBe(false);
  });

  test("a source write-and-restore during watch setup cannot escape through the allocation gap", async () => {
    await mkdir(root, { recursive: true });
    const source = join(root, "source.ts");
    const original = "export {};\n";
    await writeFile(source, original);
    let mutations = 0;
    let injected = false;
    setSessionGoalReviewWatchFactoryForTest((_directory, _options, listener) => {
      if (!injected) {
        injected = true;
        writeFileSync(source, "mutated\n");
        writeFileSync(source, original);
      }
      const watcher = new FakeWatch(listener);
      watches.push(watcher);
      return watcher;
    });

    const monitor = await SessionGoalReviewSourceMonitor.start({
      cwd: root,
      logger: silentLogger,
      onSourceMutation: async () => { mutations += 1; },
    });
    await monitor.dispose();

    expect(mutations).toBe(1);
    expect(monitor.invalidationReason).toBe("metadata_changed_during_watch_start");
    expect(monitor.isWatching).toBe(false);
  });

  test("watch errors and ambiguous source events fail closed", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "source.ts"), "export {};\n");
    let errorMutations = 0;
    const errored = await SessionGoalReviewSourceMonitor.start({
      cwd: root,
      logger: silentLogger,
      onSourceMutation: async () => { errorMutations += 1; },
    });
    watches[0]!.emitError(new Error("watch failed"));
    await errored.dispose();
    expect(errorMutations).toBe(1);
    expect(errored.invalidationReason).toBe("watch_error");
    expect(errored.isWatching).toBe(false);

    let ambiguousMutations = 0;
    const ambiguous = await SessionGoalReviewSourceMonitor.start({
      cwd: root,
      logger: silentLogger,
      onSourceMutation: async () => { ambiguousMutations += 1; },
    });
    watches[1]!.emit("rename", null);
    await ambiguous.dispose();
    expect(ambiguousMutations).toBe(1);
    expect(ambiguous.invalidationReason).toBe("filename_unavailable");
    expect(ambiguous.isWatching).toBe(false);
  });
});

class FakeWatch {
  #errorListener?: (error: Error) => void;
  #closed = false;

  constructor(private readonly listener: (eventType: string, filename: string | Buffer | null) => void) {}

  close(): void {
    this.#closed = true;
  }

  on(event: "error", listener: (error: Error) => void): this {
    if (event === "error") this.#errorListener = listener;
    return this;
  }

  emit(eventType: string, filename: string | Buffer | null): void {
    if (!this.#closed) this.listener(eventType, filename);
  }

  emitError(error: Error): void {
    if (!this.#closed) this.#errorListener?.(error);
  }
}

async function writeAndRestore(path: string, original: string): Promise<void> {
  await writeFile(path, "mutated\n");
  await writeFile(path, original);
}

async function git(args: readonly string[]): Promise<void> {
  const child = Bun.spawn(["git", "-C", root, ...args], { stderr: "pipe" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(await new Response(child.stderr).text());
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for condition");
}
