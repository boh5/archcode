import { describe, expect, mock, test } from "bun:test";
import {
  LAUNCHER_CHILD_ENV,
  runServerLauncher,
  type LauncherChild,
  type LauncherRuntime,
} from "./launcher";
import { UPDATE_RESTART_EXIT_CODE } from "./updater";

describe("server update launcher", () => {
  test("re-executes the replaced binary only for the private restart exit code", async () => {
    const commands: Array<readonly string[]> = [];
    const environments: Array<Record<string, string | undefined>> = [];
    const exits = [
      Promise.resolve(UPDATE_RESTART_EXIT_CODE),
      Promise.resolve(0),
    ];
    const runtime = createRuntime({
      spawn(command, environment) {
        commands.push([...command]);
        environments.push(environment);
        return {
          exited: exits.shift()!,
          kill: () => undefined,
        };
      },
    });

    await expect(runServerLauncher(["--port", "5000"], runtime)).resolves.toBe(0);

    expect(commands).toEqual([
      ["/managed/archcode", "--port", "5000"],
      ["/managed/archcode", "--port", "5000"],
    ]);
    expect(environments).toHaveLength(2);
    expect(environments.every(
      (environment) => environment[LAUNCHER_CHILD_ENV] === "1",
    )).toBe(true);
  });

  test("forwards a terminal signal to the child and removes its listeners", async () => {
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const kill = mock((_signal: "SIGINT" | "SIGTERM") => undefined);
    const listeners = new Map<string, () => void>();
    const removed: string[] = [];
    const runtime = createRuntime({
      spawn: () => ({ exited, kill }),
      on(signal, listener) {
        listeners.set(signal, listener);
      },
      off(signal) {
        removed.push(signal);
      },
    });

    const running = runServerLauncher([], runtime);
    listeners.get("SIGTERM")?.();
    resolveExit(143);

    await expect(running).resolves.toBe(143);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(removed).toEqual(["SIGINT", "SIGTERM"]);
  });
});

function createRuntime(
  overrides: Partial<LauncherRuntime>,
): LauncherRuntime {
  return {
    executablePath: "/managed/archcode",
    environment: { PATH: "/usr/bin" },
    spawn: () => ({
      exited: Promise.resolve(0),
      kill: () => undefined,
    } satisfies LauncherChild),
    on: () => undefined,
    off: () => undefined,
    ...overrides,
  };
}
