import type { NormalizedShellInvocation, NormalizedShellRequest, PermissionApprovalScope, ShellEffectKind } from "../../permission/policy-types";

const EXACT_ONLY_EFFECTS = new Set<ShellEffectKind>([
  "write",
  "delete",
  "remote-exec",
  "credential-exfil",
  "system-mutation",
  "protected-specra",
  "parser-uncertain",
  "execute-code",
]);

const EXACT_ONLY_COMMANDS = new Set(["ssh", "scp", "rsync"]);
const GIT_BROAD_SUBCOMMANDS = new Set(["status", "diff", "log"]);
const BUN_BROAD_SUBCOMMANDS = new Set(["add", "install"]);
const PACKAGE_MANAGER_COMMANDS = new Set(["npm", "pnpm", "yarn"]);
const PACKAGE_MANAGER_BROAD_SUBCOMMANDS = new Set(["add", "install"]);
const CURL_WRITE_OR_UPLOAD_FLAGS = new Set([
  "-o",
  "--output",
  "-O",
  "--remote-name",
  "-T",
  "--upload-file",
  "-d",
  "--data",
  "--data-raw",
  "--data-binary",
  "-F",
  "--form",
  "-X",
  "--request",
]);

function uniqueEffects(request: NormalizedShellRequest): ShellEffectKind[] {
  return [...new Set(request.effects.map((effect) => effect.kind))];
}

function exactScope(request: NormalizedShellRequest): PermissionApprovalScope {
  return {
    kind: "bash-exact",
    normalized: request.display,
    effects: uniqueEffects(request),
  };
}

function hasWriteRedirection(request: NormalizedShellRequest): boolean {
  return request.invocations.some((invocation) =>
    invocation.redirections.some((redirection) => redirection.operation !== "read"),
  );
}

function hasExactOnlyEffect(request: NormalizedShellRequest): boolean {
  return request.effects.some((effect) => EXACT_ONLY_EFFECTS.has(effect.kind));
}

function isProtectedSpecraMutation(request: NormalizedShellRequest): boolean {
  return request.effects.some((effect) => effect.kind === "protected-specra");
}

function hasParserUncertainty(request: NormalizedShellRequest): boolean {
  return request.uncertainty.length > 0 || request.effects.some((effect) => effect.kind === "parser-uncertain");
}

function singleInvocation(request: NormalizedShellRequest): NormalizedShellInvocation | undefined {
  return request.invocations.length === 1 ? request.invocations[0] : undefined;
}

function bashCommandScope(command: string, subcommand: string): PermissionApprovalScope {
  return {
    kind: "bash-command",
    command,
    subcommands: [subcommand],
    argumentMode: "any",
    effects: [],
  };
}

function curlMethod(argv: string[]): string {
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "-I" || arg === "--head") return "HEAD";
    if ((arg === "-X" || arg === "--request") && argv[index + 1]) return argv[index + 1]!.toUpperCase();
    if (arg.startsWith("-X") && arg.length > 2) return arg.slice(2).toUpperCase();
    if (arg.startsWith("--request=")) return arg.slice("--request=".length).toUpperCase();
  }
  return "GET";
}

function isOrdinaryCurlRead(invocation: NormalizedShellInvocation): boolean {
  const method = curlMethod(invocation.argv);
  if (method !== "GET" && method !== "HEAD") return false;
  return !invocation.argv.slice(1).some((arg) => {
    if (CURL_WRITE_OR_UPLOAD_FLAGS.has(arg)) return true;
    return ["--output=", "--upload-file=", "--data=", "--data-raw=", "--data-binary=", "--form=", "--request="].some((prefix) => arg.startsWith(prefix));
  });
}

function broadScopeForInvocation(invocation: NormalizedShellInvocation): PermissionApprovalScope | undefined {
  const subcommand = invocation.argv[1];
  if (!subcommand) return undefined;

  if (invocation.command === "git" && GIT_BROAD_SUBCOMMANDS.has(subcommand)) {
    return bashCommandScope("git", subcommand);
  }

  if (invocation.command === "bun") {
    if (subcommand === "run" && invocation.argv[2]) return bashCommandScope("bun", "run");
    if (BUN_BROAD_SUBCOMMANDS.has(subcommand)) return bashCommandScope("bun", subcommand);
  }

  if (PACKAGE_MANAGER_COMMANDS.has(invocation.command) && PACKAGE_MANAGER_BROAD_SUBCOMMANDS.has(subcommand)) {
    return bashCommandScope(invocation.command, subcommand);
  }

  if (invocation.command === "curl" && isOrdinaryCurlRead(invocation)) {
    return bashCommandScope("curl", curlMethod(invocation.argv).toLowerCase());
  }

  return undefined;
}

export function deriveShellApprovalScope(request: NormalizedShellRequest): PermissionApprovalScope {
  if (hasParserUncertainty(request) || isProtectedSpecraMutation(request)) return exactScope(request);
  if (hasWriteRedirection(request) || hasExactOnlyEffect(request)) return exactScope(request);

  const invocation = singleInvocation(request);
  if (!invocation) return exactScope(request);
  if (EXACT_ONLY_COMMANDS.has(invocation.command)) return exactScope(request);

  return broadScopeForInvocation(invocation) ?? exactScope(request);
}
