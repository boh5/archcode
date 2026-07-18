import { afterEach, describe, expect, mock, test } from "bun:test";
import { createProcessRunner, setProcessRunnerForTest } from "../runner";

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function generatedStream(totalBytes: number, fill: number): {
  stream: ReadableStream<Uint8Array>;
  cancelled: () => number;
} {
  const chunk = new Uint8Array(64 * 1024).fill(fill);
  let remaining = totalBytes;
  let cancelCount = 0;
  return {
    stream: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining === 0) {
          controller.close();
          return;
        }
        const count = Math.min(remaining, chunk.byteLength);
        controller.enqueue(count === chunk.byteLength ? chunk : chunk.subarray(0, count));
        remaining -= count;
      },
      cancel() { cancelCount += 1; },
    }, { highWaterMark: 0 }),
    cancelled: () => cancelCount,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

  test("returns timeout after killing the process", async () => {
    const exit = deferred<number>();
    const kill = mock(() => exit.resolve(143));
    setProcessRunnerForTest(() => ({
      stdout: streamFromText(""),
      stderr: streamFromText(""),
      exited: exit.promise,
      exitCode: null,
      signalCode: null,
      kill,
    }) as any);

    const result = await createProcessRunner().run({ argv: ["sleep", "1"], cwd: "/tmp", timeoutMs: 1 });

    expect(kill).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("timeout");
    if (result.kind === "timeout") {
      expect(result.timeoutMs).toBe(1);
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

    const promise = createProcessRunner().run({ argv: ["sleep", "1"], cwd: "/tmp", signal: controller.signal });
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

    const result = await createProcessRunner().run({ argv: ["echo", "done"], cwd: "/tmp" });

    expect(result.kind).toBe("success");
    expect(spawn).toHaveBeenCalledTimes(4);
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

  test("drains 256 MiB from each stream with fixed 1 MiB rings and no reader cancellation", async () => {
    const bytesPerStream = 256 * 1024 * 1024;
    const stdout = generatedStream(bytesPerStream, 0x61);
    const stderr = generatedStream(bytesPerStream, 0x62);
    const received = { stdout: 0, stderr: 0 };
    setProcessRunnerForTest(() => ({
      stdout: stdout.stream,
      stderr: stderr.stream,
      exited: Promise.resolve(0),
      exitCode: 0,
      signalCode: null,
      kill: mock(() => {}),
    }) as any);

    const result = await createProcessRunner().run({
      argv: ["large-output"],
      outputSink: {
        write(stream, chunk) {
          received[stream] += chunk.byteLength;
        },
      },
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(received).toEqual({ stdout: bytesPerStream, stderr: bytesPerStream });
      expect(result.output.stdoutBytes).toBe(bytesPerStream);
      expect(result.output.stderrBytes).toBe(bytesPerStream);
      expect(result.output.stdout.length).toBe(1024 * 1024);
      expect(result.output.stderr.length).toBe(1024 * 1024);
      expect(result.output.sinkStatus).toBe("complete");
      expect(stdout.cancelled()).toBe(0);
      expect(stderr.cancelled()).toBe(0);
    }
  }, 30_000);

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

  test("discards a sink that never resolves after one second and still drains to EOF", async () => {
    const stdout = "a".repeat(2 * 64 * 1024);
    setProcessRunnerForTest(() => createFakeProcess({ stdout, exitCode: 0 }) as any);

    const startedAt = Date.now();
    const result = await createProcessRunner().run({
      argv: ["stalled-sink"],
      maxOutputBytes: 16,
      outputSink: { write: () => new Promise<void>(() => undefined) },
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
      expect(result.output.stdoutBytes).toBe(stdout.length);
      expect(result.output.sinkStatus).toBe("discarded");
    }
  });

  test("continues non-blocking discarded observation after the sink deadline", async () => {
    const stdout = generatedStream(4 * 64 * 1024, 0x61);
    let observed = 0;
    let writes = 0;
    setProcessRunnerForTest(() => ({
      stdout: stdout.stream,
      stderr: streamFromText(""),
      exited: Promise.resolve(0),
      exitCode: 0,
      signalCode: null,
      kill: mock(() => {}),
    }) as any);

    const result = await createProcessRunner().run({
      argv: ["observing-stalled-sink"],
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

    expect(result.kind).toBe("success");
    expect(writes).toBe(1);
    expect(observed).toBe(4 * 64 * 1024);
    expect(result.kind === "success" && result.output.sinkStatus).toBe("discarded");
    expect(stdout.cancelled()).toBe(0);
  });
});
