import { UPDATE_RESTART_EXIT_CODE } from "./updater";

export const LAUNCHER_CHILD_ENV = "ARCHCODE_LAUNCHER_CHILD";

type LauncherSignal = "SIGINT" | "SIGTERM";

export interface LauncherChild {
  readonly exited: Promise<number>;
  kill(signal: LauncherSignal): void;
}

export interface LauncherRuntime {
  readonly executablePath: string;
  readonly environment: Record<string, string | undefined>;
  spawn(
    command: readonly string[],
    environment: Record<string, string | undefined>,
  ): LauncherChild;
  on(signal: LauncherSignal, listener: () => void): void;
  off(signal: LauncherSignal, listener: () => void): void;
}

const systemLauncherRuntime: LauncherRuntime = {
  executablePath: process.execPath,
  environment: Bun.env,
  spawn(command, environment) {
    return Bun.spawn([...command], {
      env: environment,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  },
  on(signal, listener) {
    process.on(signal, listener);
  },
  off(signal, listener) {
    process.off(signal, listener);
  },
};

export function isCompiledRuntime(): boolean {
  return import.meta.url.startsWith("file:///$bunfs/");
}

export function isLauncherChild(): boolean {
  return Bun.env[LAUNCHER_CHILD_ENV] === "1";
}

/**
 * Stable parent process for the replace-on-disk executable. Exit code 75 is a
 * private child-to-launcher restart request; every other exit is terminal.
 */
export async function runServerLauncher(
  args: readonly string[],
  runtime: LauncherRuntime = systemLauncherRuntime,
): Promise<number> {
  let child: LauncherChild | undefined;
  let stoppingSignal: LauncherSignal | undefined;
  const forwardSignal = (signal: LauncherSignal): void => {
    stoppingSignal = signal;
    child?.kill(signal);
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  runtime.on("SIGINT", onSigint);
  runtime.on("SIGTERM", onSigterm);

  try {
    while (stoppingSignal === undefined) {
      child = runtime.spawn(
        [runtime.executablePath, ...args],
        {
          ...runtime.environment,
          [LAUNCHER_CHILD_ENV]: "1",
        },
      );
      const exitCode = await child.exited;
      child = undefined;
      if (stoppingSignal !== undefined) return exitCode;
      if (exitCode !== UPDATE_RESTART_EXIT_CODE) return exitCode;
    }
    return 0;
  } finally {
    runtime.off("SIGINT", onSigint);
    runtime.off("SIGTERM", onSigterm);
  }
}
