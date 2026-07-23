import { CLI_BINARY_NAME, PRODUCT_DISPLAY_NAME } from "@archcode/protocol";

export type CliInvocation =
  | { kind: "start" }
  | { kind: "print"; exitCode: 0 | 1; output: string; stream: "stdout" | "stderr" };

function formatHelp(version: string): string {
  return [
    `${PRODUCT_DISPLAY_NAME} ${version}`,
    "",
    `Usage: ${CLI_BINARY_NAME} [options]`,
    "",
    "Options:",
    "  -h, --help       Show this help",
    "  -V, --version    Show the version",
    "",
  ].join("\n");
}

export function resolveCliInvocation(args: readonly string[], version: string): CliInvocation {
  if (args.length === 0) {
    return { kind: "start" };
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

  return {
    kind: "print",
    exitCode: 1,
    output: `Unknown option: ${args.join(" ")}\n\n${formatHelp(version)}`,
    stream: "stderr",
  };
}
