import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  createProcessRunner,
  setProcessRunnerForTest,
  type ProcessRunnerDeadlineHandle,
  type ProcessRunnerScheduler,
} from "../runner";

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface ManualProcessScheduler extends ProcessRunnerScheduler {
  readonly sleeps: number[];
  fireScheduled(): void;
  whenScheduled(): Promise<void>;
}

function createManualProcessScheduler(): ManualProcessScheduler {
  let nextId = 1;
  const scheduled = new Map<number, () => void>();
  const waiters = new Set<() => void>();
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
    },
    schedule: (_delayMs, callback) => {
      const id = nextId++;
      scheduled.set(id, callback);
      for (const resolve of waiters) resolve();
      waiters.clear();
      return { id };
    },
    cancel: (handle: ProcessRunnerDeadlineHandle) => {
      if (typeof handle.id === "number") scheduled.delete(handle.id);
    },
    fireScheduled: () => {
      const callbacks = [...scheduled.values()];
      scheduled.clear();
      for (const callback of callbacks) callback();
    },
    whenScheduled: async () => {
      if (scheduled.size > 0) return;
      await new Promise<void>((resolve) => waiters.add(resolve));
    },
  };
}

function createFakeProcess(params: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  signalCode?: number | string | null;
}) {
  return {
    stdout: streamFromText(params.stdout ?? ""),
    stderr: streamFromText(params.stderr ?? ""),
    exited: Promise.resolve(params.exitCode ?? 0),
    exitCode: params.exitCode ?? 0,
    signalCode: params.signalCode ?? null,
    kill: mock(() => {}),
  };
}

describe("process runner", () => {
  afterEach(() => {
    setProcessRunnerForTest(undefined);
  });

  test("returns success for exit code 0", async () => {
    const spawn = mock(() => createFakeProcess({ stdout: "ok", stderr: "", exitCode: 0 }));
    setProcessRunnerForTest(spawn as any);

    const result = await createProcessRunner().run({ argv: ["echo", "ok"], cwd: "/tmp" });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.exitCode).toBe(0);
      expect(result.output.stdout).toBe("ok");
      expect(result.output.stderr).toBe("");
      expect(result.output.combined).toBe("ok");
    }
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test("returns nonzero for non-zero exit code", async () => {
    setProcessRunnerForTest(() => createFakeProcess({ stdout: "", stderr: "boom", exitCode: 7 }) as any);

    const result = await createProcessRunner().run({ argv: ["false"], cwd: "/tmp" });

    expect(result.kind).toBe("nonzero");
    if (result.kind === "nonzero") {
      expect(result.exitCode).toBe(7);
      expect(result.output.stderr).toBe("boom");
    }
  });

  test("returns timeout after a manually triggered deadline kills the process", async () => {
    const exit = deferred<number>();
    const kill = mock(() => exit.resolve(143));
    const scheduler = createManualProcessScheduler();
    setProcessRunnerForTest(() => ({
      stdout: streamFromText(""),
      stderr: streamFromText(""),
      exited: exit.promise,
      exitCode: null,
      signalCode: null,
      kill,
    }) as any);

    const running = createProcessRunner({ scheduler }).run({
      argv: ["hung-process"],
      cwd: "/tmp",
      timeoutMs: 60_000,
    });
    await scheduler.whenScheduled();
    scheduler.fireScheduled();

    const result = await running;
    expect(kill).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("timeout");
    if (result.kind === "timeout") {
      expect(result.timeoutMs).toBe(60_000);
      expect(result.exitCode).toBe(143);
    }
  });

  test("returns aborted after signal fires and kills the process", async () => {
    const exit = deferred<number>();
    const kill = mock(() => exit.resolve(143));
    const controller = new AbortController();
    setProcessRunnerForTest(() => ({
      stdout: streamFromText(""),
      stderr: streamFromText(""),
      exited: exit.promise,
      exitCode: null,
      signalCode: null,
      kill,
    }) as any);

    const promise = createProcessRunner().run({ argv: ["hung-process"], cwd: "/tmp", signal: controller.signal });
    controller.abort("stop");

    const result = await promise;
    expect(kill).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("aborted");
    if (result.kind === "aborted") {
      expect(result.reason).toBe("stop");
      expect(result.exitCode).toBe(143);
    }
  });

  test("returns signal when the child exits from a signal", async () => {
    setProcessRunnerForTest(() =>
      createFakeProcess({ stdout: "", stderr: "", exitCode: 143, signalCode: "SIGTERM" }) as any,
    );

    const result = await createProcessRunner().run({ argv: ["child"], cwd: "/tmp" });

    expect(result.kind).toBe("signal");
    if (result.kind === "signal") {
      expect(result.signal).toBe("SIGTERM");
      expect(result.exitCode).toBe(143);
    }
  });

  test("returns spawn failure when spawn throws non-EAGAIN error", async () => {
    const error = new Error("spawn failed");
    setProcessRunnerForTest(() => {
      throw error;
    });

    const result = await createProcessRunner().run({ argv: ["missing"], cwd: "/tmp" });

    expect(result.kind).toBe("spawn-failure");
    if (result.kind === "spawn-failure") {
      expect(result.error.message).toBe("Process failed to start");
      expect(result.error).not.toHaveProperty("stack");
      expect(result.error).not.toHaveProperty("cause");
      expect(result.error.name).toBe("Error");
    }
  });

  test("retries EAGAIN spawn failures up to three times", async () => {
    const error = Object.assign(new Error("temporarily unavailable"), { code: "EAGAIN" });
    const spawn = mock(() => {
      if (spawn.mock.calls.length < 4) throw error;
      return createFakeProcess({ stdout: "done", exitCode: 0 }) as any;
    });
    setProcessRunnerForTest(spawn as any);

    const scheduler = createManualProcessScheduler();
    const result = await createProcessRunner({ scheduler }).run({ argv: ["echo", "done"], cwd: "/tmp" });

    expect(result.kind).toBe("success");
    expect(spawn).toHaveBeenCalledTimes(4);
    expect(scheduler.sleeps).toEqual([10, 20, 30]);
  });

  test("retains bounded head and tail independently while draining both streams", async () => {
    setProcessRunnerForTest(() =>
      createFakeProcess({ stdout: "abcdef", stderr: "ghijkl", exitCode: 0 }) as any,
    );

    const result = await createProcessRunner().run({
      argv: ["echo", "data"],
      cwd: "/tmp",
      maxOutputBytes: 5,
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.output.stdout).toBe("abcef");
      expect(result.output.stderr).toBe("ghikl");
      expect(result.output.stdoutTruncated).toBe(true);
      expect(result.output.stderrTruncated).toBe(true);
      expect(result.output.combinedTruncated).toBe(true);
      expect(result.output.maxOutputBytes).toBe(5);
      expect(result.output.stdoutBytes).toBe(6);
      expect(result.output.stderrBytes).toBe(6);
      expect(result.output.sinkStatus).toBe("unused");
    }
  });

  test("discards a rejected sink and still drains later output", async () => {
    let writes = 0;
    const stdout = "a".repeat(3 * 64 * 1024);
    setProcessRunnerForTest(() => createFakeProcess({ stdout, exitCode: 0 }) as any);

    const result = await createProcessRunner().run({
      argv: ["rejecting-sink"],
      maxOutputBytes: 16,
      outputSink: {
        write() {
          writes += 1;
          throw new Error("closed");
        },
      },
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(writes).toBeGreaterThanOrEqual(1);
      expect(result.output.stdoutBytes).toBe(stdout.length);
      expect(result.output.sinkStatus).toBe("discarded");
      expect(result.output.stdoutTruncated).toBe(true);
    }
  });

  test("serializes concurrent stdout and stderr sink writes", async () => {
    const stdout = "a".repeat(2 * 64 * 1024);
    const stderr = "b".repeat(2 * 64 * 1024);
    let active = 0;
    let peak = 0;
    setProcessRunnerForTest(() => createFakeProcess({ stdout, stderr, exitCode: 0 }) as any);

    await createProcessRunner().run({
      argv: ["serialized-sink"],
      outputSink: {
        async write() {
          active++;
          peak = Math.max(peak, active);
          await Promise.resolve();
          active--;
        },
      },
    });

    expect(peak).toBe(1);
  });

  test("discards a stalled sink after a manually triggered deadline and still drains output", async () => {
    const stdout = "a".repeat(4 * 64 * 1024);
    let observed = 0;
    let writes = 0;
    const scheduler = createManualProcessScheduler();
    setProcessRunnerForTest(() => createFakeProcess({ stdout, exitCode: 0 }) as any);

    const running = createProcessRunner({ scheduler }).run({
      argv: ["stalled-sink"],
      maxOutputBytes: 16,
      outputSink: {
        write(_stream, chunk) {
          writes += 1;
          observed += chunk.byteLength;
          return new Promise<void>(() => undefined);
        },
        discard(_stream, chunk) {
          observed += chunk.byteLength;
        },
      },
    });
    await scheduler.whenScheduled();
    scheduler.fireScheduled();

    const result = await running;
    expect(result.kind).toBe("success");
    expect(writes).toBe(1);
    expect(observed).toBe(stdout.length);
    expect(result.kind === "success" && result.output.sinkStatus).toBe("discarded");
  });

});
