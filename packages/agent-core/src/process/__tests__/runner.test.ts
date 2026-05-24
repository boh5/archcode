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
      expect(result.error.message).toBe("spawn failed");
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

  test("truncates stdout and stderr by maxOutputBytes", async () => {
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
      expect(result.output.stdout).toBe("abcde");
      expect(result.output.stderr).toBe("");
      expect(result.output.stdoutTruncated).toBe(true);
      expect(result.output.stderrTruncated).toBe(true);
      expect(result.output.combinedTruncated).toBe(true);
      expect(result.output.maxOutputBytes).toBe(5);
    }
  });
});
