import { CLI_BINARY_NAME, ENV_PORT, PRODUCT_DISPLAY_NAME } from "@archcode/protocol";

export type CliInvocation =
  | { kind: "start"; port: number }
  | { kind: "print"; exitCode: 0 | 1; output: string; stream: "stdout" | "stderr" };

function formatHelp(version: string): string {
  return [
    `${PRODUCT_DISPLAY_NAME} ${version}`,
    "",
    `Usage: ${CLI_BINARY_NAME} [options]`,
    "",
    "Options:",
    "  -p, --port <port>  Listen on this port (default: ARCHCODE_PORT or 4096)",
    "  -h, --help         Show this help",
    "  -V, --version      Show the version",
    "",
  ].join("\n");
}

function invalidPort(message: string, version: string): CliInvocation {
  return {
    kind: "print",
    exitCode: 1,
    output: `${message}\n\n${formatHelp(version)}`,
    stream: "stderr",
  };
}

function parsePort(
  rawPort: string,
  source: "--port" | typeof ENV_PORT,
  version: string,
): number | CliInvocation {
  if (!/^[1-9]\d*$/.test(rawPort)) {
    return invalidPort(
      `Invalid ${source} value ${JSON.stringify(rawPort)}: expected an integer from 1 to 65535.`,
      version,
    );
  }

  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    return invalidPort(
      `Invalid ${source} value ${JSON.stringify(rawPort)}: expected an integer from 1 to 65535.`,
      version,
    );
  }
  return port;
}

export function resolveCliInvocation(
  args: readonly string[],
  version: string,
  environmentPort?: string,
): CliInvocation {
  if (args.length === 0) {
    if (environmentPort === undefined) {
      return { kind: "start", port: 4096 };
    }
    const port = parsePort(environmentPort, ENV_PORT, version);
    return typeof port === "number" ? { kind: "start", port } : port;
  }

  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
    return {
      kind: "print",
      exitCode: 0,
      output: `${CLI_BINARY_NAME} ${version}\n`,
      stream: "stdout",
    };
  }

  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return {
      kind: "print",
      exitCode: 0,
      output: formatHelp(version),
      stream: "stdout",
    };
  }

  const rawPort = args.length === 1 && args[0]?.startsWith("--port=")
    ? args[0].slice("--port=".length)
    : args.length === 2 && (args[0] === "--port" || args[0] === "-p")
      ? args[1]
      : undefined;
  if (rawPort !== undefined) {
    const port = parsePort(rawPort, "--port", version);
    return typeof port === "number" ? { kind: "start", port } : port;
  }
  if (args.length === 1 && (args[0] === "--port" || args[0] === "-p")) {
    return invalidPort(`Missing value for ${args[0]}.`, version);
  }

  return {
    kind: "print",
    exitCode: 1,
    output: `Unknown option: ${args.join(" ")}\n\n${formatHelp(version)}`,
    stream: "stderr",
  };
}
