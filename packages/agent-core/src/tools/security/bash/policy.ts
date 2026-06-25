import { normalize } from "node:path";
import type { NormalizedShellInvocation, NormalizedShellRequest, PermissionApprovalScope, ShellEffect, ShellPathReference } from "../../permission/policy-types";
import type { PermissionDecision } from "../../types";
import { PathValidator } from "../path-validator";
import { attachShellEffects } from "./effects";
import type { ShellParseFailure } from "./parse";
import { deriveShellApprovalScope } from "./scopes";

export interface ClassifyCommandOptions {
  workspaceRoot: string;
  cwd?: string;
}

const ASK_PROMPT = "Review this bash command before execution.";
const DENY_EFFECTS = new Set(["system-mutation", "remote-exec", "credential-exfil", "protected-path"]);

interface DenyRule {
  ruleId: string;
  reason: string;
  matches(request: NormalizedShellRequest): boolean;
}

interface AskRule {
  ruleId: string;
  reason: string;
  match(request: NormalizedShellRequest, validator: PathValidator): AskRuleMatch | undefined;
}

interface AskRuleMatch {
  display?: string;
  eligible: boolean;
  scope?: PermissionApprovalScope;
}

const RULE_REASONS = {
  privilegeEscalation: "Privilege escalation or user switching is blocked",
  remoteExec: "Downloaded content executed by an interpreter is blocked",
  catastrophicDelete: "Catastrophic deletion of system paths is blocked",
  diskDestructive: "Disk, filesystem, or device destructive command is blocked",
  securityWrites: "System service, firewall, or security setting writes are blocked",
  credentialExfil: "Credential material exfiltration is blocked",
  permissionsFile: "Protected permission file access is blocked",
  pathMutation: "Direct mutation of .archcode is blocked",
  background: "Background execution with & is not supported",
  outOfWorkspace: "Bash path access outside the workspace requires confirmation",
  sensitivePath: "Sensitive file access requires confirmation",
  parserUncertainty: "Parser uncertainty requires confirmation",
  writeRedirection: "Write redirection requires confirmation",
  outsideTransfer: "File transfer touching paths outside the workspace requires confirmation",
  remoteCommand: "Remote command execution requires confirmation",
  gitPush: "Git push requires confirmation",
  destructiveLocal: "Destructive local command requires confirmation",
} as const;

const PRIVILEGE_COMMANDS = new Set(["sudo", "su", "doas", "pkexec", "runuser"]);
const SHELL_EXECUTORS = new Set(["sh", "bash", "zsh", "python", "python3", "node", "ruby", "perl"]);
const DOWNLOAD_COMMANDS = new Set(["curl", "wget", "fetch", "http"]);
const SECURITY_WRITE_COMMANDS = new Set(["iptables", "nft", "csrutil"]);
const CATASTROPHIC_DELETE_TARGETS = new Set(["/", "~", "$HOME", "${HOME}", "/Users", "/home", "/etc", "/usr", "/bin", "/sbin", "/var", "/opt", "/System", "/Library", "/Applications"]);
const FILE_MUTATORS = new Set(["rm", "mv", "cp", "tee", "mkdir", "touch", "chmod", "chown"]);
const CREDENTIAL_PATH_PATTERNS = [/^\.env(?:\..*)?$/, /(?:^|\/)\.env(?:\..*)?$/, /(?:^|\/)\.ssh(?:\/|$)/, /(?:^|\/)\.aws(?:\/|$)/, /(?:^|\/)\.config\/gcloud(?:\/|$)/, /(?:^|\/)\.azure(?:\/|$)/];
const SENSITIVE_PATH_PATTERNS = [
  /^\.env(?:\..*)?$/,
  /(?:^|\/)\.env(?:\..*)?$/,
  /(?:^|\/)\.ssh(?:\/|$)/,
  /(?:^|\/)\.aws(?:\/|$)/,
  /(?:^|\/)\.config\/gcloud(?:\/|$)/,
  /(?:^|\/)\.azure(?:\/|$)/,
  /(?:^|\/)\.npmrc$/,
  /(?:^|\/)\.pypirc$/,
  /(?:^|\/)\.netrc$/,
  /(?:^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/,
  /(?:^|\/).+\.(?:pem|key|p12|pfx)$/,
];
const CREDENTIAL_EXFIL_COMMANDS = new Set(["curl", "wget", "scp", "rsync", "nc", "netcat"]);
const REMOTE_COPY_COMMANDS = new Set(["scp", "rsync"]);
const DESTRUCTIVE_LOCAL_COMMANDS = new Set(["rm", "rmdir"]);
const COMMON_ALLOWED_COMMANDS = new Set([
  "make",
  "cargo",
  "rustc",
  "go",
  "python",
  "python3",
  "node",
  "deno",
  "tsc",
]);
const PROTECTED_PERMISSIONS_TEXT_PATTERN = /(?:\.\/)?\.archcode\/permissions\.json/;

function ask(reason: string, display?: string, eligible = true, request?: NormalizedShellRequest, ruleId?: string, scope?: PermissionApprovalScope): PermissionDecision {
  return {
    outcome: "ask",
    reason,
    prompt: ASK_PROMPT,
    display,
    source: "builtin-policy",
    ruleId,
    approval: {
      eligible,
      scope: eligible ? (scope ?? (request ? deriveShellApprovalScope(request) : undefined)) : undefined,
      display: display ?? request?.display ?? "",
      reason,
    },
  };
}

function deny(reason: string, display?: string, ruleId?: string): PermissionDecision {
  return { outcome: "deny", reason, display, source: "builtin-policy", ruleId };
}

function allow(display?: string): PermissionDecision {
  return { outcome: "allow", display, source: "builtin-policy" };
}

function combinePermissionDecisions(decisions: PermissionDecision[]): PermissionDecision {
  if (decisions.length === 0) return allow();
  for (const decision of decisions) if (decision.outcome === "deny") return decision;
  for (const decision of decisions) if (decision.outcome === "ask") return decision;
  return allow();
}

function validateCwd(options: ClassifyCommandOptions): PathValidator | undefined {
  const rootValidator = new PathValidator(options.workspaceRoot);
  if (!options.cwd) return rootValidator;
  const cwdResult = rootValidator.validate(options.cwd);
  if (!cwdResult.ok) return undefined;
  return new PathValidator(cwdResult.resolvedPath);
}

function pathArgs(argv: string[], optionsWithValues = new Set<string>()): string[] {
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("-")) {
      if (optionsWithValues.has(arg) && !arg.includes("=")) i += 1;
      continue;
    }
    paths.push(arg);
  }
  return paths;
}

function validatePaths(paths: string[], validator: PathValidator): boolean {
  return paths.every((path) => validator.validate(path).ok);
}

function pathScope(path: string, operation: "read" | "write" | "delete", validator: PathValidator): PermissionApprovalScope {
  return { kind: "file-path", operation, path: validator.validate(path).resolvedPath, pathMode: "exact" };
}

function shellScope(request: NormalizedShellRequest): PermissionApprovalScope {
  return deriveShellApprovalScope(request);
}

function stripTrailingSlash(path: string): string {
  const stripped = path.replace(/\/+$/, "");
  return stripped.length === 0 ? "/" : stripped;
}

function isProjectPath(rawPath: string): boolean {
  const normalized = normalize(rawPath);
  return normalized === ".archcode" || normalized.startsWith(".archcode/") || normalized.includes("/.archcode/") || normalized.endsWith("/.archcode");
}

function isPermissionsPath(rawPath: string): boolean {
  const normalized = normalize(rawPath);
  return normalized === ".archcode/permissions.json" || normalized.endsWith("/.archcode/permissions.json");
}

function mentionsPermissionsPath(rawText: string): boolean {
  return PROTECTED_PERMISSIONS_TEXT_PATTERN.test(rawText);
}

function isEnvExamplePath(path: string): boolean {
  return path === ".env.example" || path.endsWith("/.env.example");
}

function isSensitivePath(path: string): boolean {
  if (isEnvExamplePath(path)) return false;
  const normalized = path.replace(/^~/, "").replace(/^@/, "").replace(/^[^=]+=@?/, "");
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function hasRecursiveForce(argv: string[]): boolean {
  let recursive = false;
  let force = false;
  for (const arg of argv.slice(1)) {
    if (arg === "--recursive") recursive = true;
    if (arg === "--force") force = true;
    if (arg.startsWith("-") && !arg.startsWith("--")) {
      recursive ||= arg.includes("r") || arg.includes("R");
      force ||= arg.includes("f");
    }
  }
  return recursive && force;
}

function hasCatastrophicTarget(argv: string[]): boolean {
  return argv.slice(1).some((arg) => CATASTROPHIC_DELETE_TARGETS.has(stripTrailingSlash(arg)));
}

function hasCredentialPath(argv: string[]): boolean {
  return argv.some((arg) => {
    const candidates = [arg, arg.replace(/^~/, ""), arg.replace(/^@/, ""), arg.replace(/^[^=]+=@?/, "")];
    return candidates.some((candidate) => CREDENTIAL_PATH_PATTERNS.some((pattern) => pattern.test(candidate)));
  });
}

function operationForPath(path: ShellPathReference): "read" | "write" | "delete" | undefined {
  if (path.operation === "read") return "read";
  if (path.operation === "write" || path.operation === "unknown") return "write";
  if (path.operation === "delete") return "delete";
  return undefined;
}

function operationForEffect(effect: ShellEffect): "read" | "write" | "delete" | undefined {
  if (effect.kind === "read") return "read";
  if (effect.kind === "write") return "write";
  if (effect.kind === "delete") return "delete";
  return undefined;
}

function firstPathMatch(request: NormalizedShellRequest, predicate: (path: string, operation: "read" | "write" | "delete") => boolean): { path: string; operation: "read" | "write" | "delete"; display: string } | undefined {
  for (const invocation of request.invocations) {
    for (const path of invocation.paths) {
      const operation = operationForPath(path);
      if (operation && predicate(path.path, operation)) return { path: path.path, operation, display: invocation.display };
    }
    for (const redirection of invocation.redirections) {
      const operation = redirection.operation === "read" ? "read" : "write";
      if (predicate(redirection.target, operation)) return { path: redirection.target, operation, display: invocation.display };
    }
    if (REMOTE_COPY_COMMANDS.has(invocation.command)) {
      const positional = pathArgs(invocation.argv.slice(1), new Set(["-e", "--rsh", "--exclude", "--include"]));
      for (let index = 0; index < positional.length; index += 1) {
        const path = positional[index]!;
        if (path.includes(":")) continue;
        const operation = index === positional.length - 1 ? "write" : "read";
        if (predicate(path, operation)) return { path, operation, display: invocation.display };
      }
    }
  }
  for (const effect of request.effects) {
    const operation = operationForEffect(effect);
    if (effect.target && operation && predicate(effect.target, operation)) return { path: effect.target, operation, display: request.display };
  }
  return undefined;
}

function isGitPushInvocation(invocation: NormalizedShellInvocation): boolean {
  return invocation.command === "git" && invocation.argv[1] === "push";
}

function hasRemoteShellPayload(invocation: NormalizedShellInvocation): boolean {
  if (invocation.command !== "ssh") return false;
  const args = invocation.argv.slice(1).filter((arg) => !arg.startsWith("-"));
  return args.length >= 2;
}

function isDestructiveLocalInvocation(invocation: NormalizedShellInvocation): boolean {
  if (DESTRUCTIVE_LOCAL_COMMANDS.has(invocation.command)) return true;
  if (invocation.command === "git" && invocation.argv[1] === "reset" && invocation.argv.includes("--hard")) return true;
  if (invocation.command === "git" && invocation.argv[1] === "clean" && invocation.argv.some((arg) => arg.includes("f"))) return true;
  return invocation.effects.some((effect) => effect.kind === "delete");
}

function isSafePackageRunnerParserUncertainty(request: NormalizedShellRequest): boolean {
  if (request.invocations.length !== 1) return false;
  const invocation = request.invocations[0]!;
  if (!["npx", "bunx"].includes(invocation.command)) return false;
  if (invocation.uncertainty.some((item) => item.token !== invocation.command)) return false;
  return request.uncertainty.every((item) => item.token === invocation.command);
}

function hasParserUncertainty(request: NormalizedShellRequest): boolean {
  return request.uncertainty.length > 0 || request.effects.some((effect) => effect.kind === "parser-uncertain");
}

function isSecurityWriteInvocation(invocation: NormalizedShellInvocation): boolean {
  const { command, argv } = invocation;
  if (SECURITY_WRITE_COMMANDS.has(command)) return true;
  if (command === "launchctl" && ["bootstrap", "bootout", "enable", "disable", "kickstart", "load", "unload", "remove", "submit", "setenv", "unsetenv"].includes(argv[1] ?? "")) return true;
  if (command === "systemctl" && ["start", "stop", "restart", "reload", "enable", "disable", "mask", "unmask", "daemon-reload", "set-property"].includes(argv[1] ?? "")) return true;
  if (command === "pfctl" && argv.some((arg) => ["-f", "-e", "-d"].includes(arg))) return true;
  if (command === "ufw" && ["enable", "disable"].includes(argv[1] ?? "")) return true;
  if (command === "security" && !["find-generic-password", "find-internet-password", "dump-keychain"].includes(argv[1] ?? "")) return true;
  if (command === "spctl" && argv.some((arg) => ["--master-disable", "--master-enable", "--add", "--remove", "--enable", "--disable"].includes(arg))) return true;
  return false;
}

function isDiskDestructiveInvocation(invocation: NormalizedShellInvocation): boolean {
  const { command, argv } = invocation;
  if (command === "dd" && argv.some((arg) => arg === "of=/dev/" || arg.startsWith("of=/dev/"))) return true;
  if (command === "mkfs" || command.startsWith("mkfs.")) return true;
  if (["fdisk", "gdisk", "parted"].includes(command)) return true;
  if (command === "diskutil" && argv[1]?.startsWith("erase")) return true;
  if (command === "zfs" && ["destroy", "rollback", "promote", "receive"].includes(argv[1] ?? "")) return true;
  if (command === "zpool" && ["destroy", "create", "labelclear", "offline", "remove", "replace"].includes(argv[1] ?? "")) return true;
  if (command === "cryptsetup" && ["luksFormat", "erase", "remove", "resize", "reencrypt"].includes(argv[1] ?? "")) return true;
  return false;
}

function isRemoteDownloadInvocation(invocation: NormalizedShellInvocation): boolean {
  return DOWNLOAD_COMMANDS.has(invocation.command) || invocation.argv.some((arg) => /^https?:\/\//.test(arg));
}

function matchesEffect(request: NormalizedShellRequest, reasonIncludes: string, kind?: string): boolean {
  return request.effects.some((effect) => (kind ? effect.kind === kind : DENY_EFFECTS.has(effect.kind)) && effect.reason.toLowerCase().includes(reasonIncludes));
}

const DENY_RULES: DenyRule[] = [
  {
    ruleId: "deny-protected-permissions-file",
    reason: RULE_REASONS.permissionsFile,
    matches: (request) => mentionsPermissionsPath(request.display),
  },
  {
    ruleId: "deny-privilege-escalation",
    reason: RULE_REASONS.privilegeEscalation,
    matches: (request) =>
      matchesEffect(request, "privilege") ||
      request.invocations.some((invocation) => PRIVILEGE_COMMANDS.has(invocation.command) || (invocation.command === "machinectl" && invocation.argv[1] === "shell") || (invocation.command === "osascript" && invocation.argv.join(" ").includes("with administrator privileges"))),
  },
  {
    ruleId: "deny-remote-exec",
    reason: RULE_REASONS.remoteExec,
    matches: (request) =>
      request.effects.some((effect) => effect.kind === "remote-exec") ||
      request.invocations.some((invocation, index) => {
        const next = request.invocations[index + 1];
        return (isRemoteDownloadInvocation(invocation) && next?.separatorBefore === "|" && SHELL_EXECUTORS.has(next.command)) || (["eval", "source", "."].includes(invocation.command) && /https?:\/\/|curl|wget|fetch|http/.test(invocation.display));
      }),
  },
  {
    ruleId: "deny-catastrophic-delete",
    reason: RULE_REASONS.catastrophicDelete,
    matches: (request) =>
      matchesEffect(request, "catastrophic") ||
      request.invocations.some((invocation) => (invocation.command === "rm" && hasRecursiveForce(invocation.argv) && hasCatastrophicTarget(invocation.argv)) || (invocation.command === "find" && hasCatastrophicTarget(invocation.argv) && (invocation.argv.includes("-delete") || (invocation.argv.includes("-exec") && invocation.argv.some((arg) => arg === "rm" || arg.endsWith("/rm"))))))
  },
  {
    ruleId: "deny-disk-filesystem-destructive",
    reason: RULE_REASONS.diskDestructive,
    matches: (request) => matchesEffect(request, "disk") || request.invocations.some(isDiskDestructiveInvocation),
  },
  {
    ruleId: "deny-system-service-security-write",
    reason: RULE_REASONS.securityWrites,
    matches: (request) => matchesEffect(request, "system service") || request.invocations.some(isSecurityWriteInvocation),
  },
  {
    ruleId: "deny-credential-exfiltration",
    reason: RULE_REASONS.credentialExfil,
    matches: (request) => request.effects.some((effect) => effect.kind === "credential-exfil") || request.invocations.some((invocation, index) => {
      const credentialInArgs = hasCredentialPath(invocation.argv);
      const credentialInReadRedirection = invocation.redirections.some((redirection) => redirection.operation === "read" && hasCredentialPath([redirection.target]));
      return (credentialInArgs && CREDENTIAL_EXFIL_COMMANDS.has(invocation.command)) || (credentialInReadRedirection && CREDENTIAL_EXFIL_COMMANDS.has(invocation.command)) || (credentialInArgs && invocation.command === "tar" && request.invocations[index + 1]?.separatorBefore === "|");
    }),
  },
  {
    ruleId: "deny-direct-path-mutation",
    reason: RULE_REASONS.pathMutation,
    matches: (request) =>
      request.effects.some((effect) => effect.kind === "protected-path" && (effect.target ? isProjectPath(effect.target) && !isPermissionsPath(effect.target) : effect.reason.toLowerCase().includes("mutation"))) ||
      request.invocations.some((invocation) => (FILE_MUTATORS.has(invocation.command) && invocation.argv.some(isProjectPath)) || (invocation.command === "git" && invocation.argv[1] === "clean" && invocation.argv.some(isProjectPath)) || invocation.redirections.some((redirection) => redirection.operation !== "read" && isProjectPath(redirection.target))),
  },
];

const ASK_RULES: AskRule[] = [
  {
    ruleId: "ask-parser-uncertainty",
    reason: RULE_REASONS.parserUncertainty,
    match: (request) => {
      if (!hasParserUncertainty(request) || isSafePackageRunnerParserUncertainty(request)) return undefined;
      return { display: request.display, eligible: false };
    },
  },
  {
    ruleId: "ask-sensitive-path-access",
    reason: RULE_REASONS.sensitivePath,
    match: (request, validator) => {
      const match = firstPathMatch(request, (path) => isSensitivePath(path));
      return match ? { display: match.display, eligible: true, scope: pathScope(match.path, match.operation, validator) } : undefined;
    },
  },
  {
    ruleId: "ask-out-of-workspace-path-access",
    reason: RULE_REASONS.outOfWorkspace,
    match: (request, validator) => {
      const match = firstPathMatch(request, (path) => !validator.validate(path).ok);
      return match ? { display: match.display, eligible: true, scope: pathScope(match.path, match.operation, validator) } : undefined;
    },
  },
  {
    ruleId: "ask-write-redirection",
    reason: RULE_REASONS.writeRedirection,
    match: (request, validator) => {
      for (const invocation of request.invocations) {
        const redirection = invocation.redirections.find((item) => item.operation !== "read");
        if (redirection) return { display: invocation.display, eligible: true, scope: pathScope(redirection.target, "write", validator) };
        const writePath = invocation.paths.find((path) => path.operation === "write" || path.operation === "unknown");
        if (writePath) return { display: invocation.display, eligible: true, scope: pathScope(writePath.path, operationForPath(writePath) ?? "write", validator) };
      }
      return undefined;
    },
  },
  {
    ruleId: "ask-outside-file-transfer",
    reason: RULE_REASONS.outsideTransfer,
    match: (request, validator) => {
      for (const invocation of request.invocations) {
        if (!REMOTE_COPY_COMMANDS.has(invocation.command)) continue;
        const match = invocation.paths.find((path) => path.operation !== "read" && !validator.validate(path.path).ok);
        if (match) return { display: invocation.display, eligible: true, scope: pathScope(match.path, "write", validator) };
      }
      return undefined;
    },
  },
  {
    ruleId: "ask-remote-command-execution",
    reason: RULE_REASONS.remoteCommand,
    match: (request) => (request.invocations.some(hasRemoteShellPayload) ? { display: request.display, eligible: true, scope: shellScope(request) } : undefined),
  },
  {
    ruleId: "ask-git-push",
    reason: RULE_REASONS.gitPush,
    match: (request) => (request.invocations.some(isGitPushInvocation) ? { display: request.display, eligible: true, scope: shellScope(request) } : undefined),
  },
  {
    ruleId: "ask-destructive-local",
    reason: RULE_REASONS.destructiveLocal,
    match: (request) => (request.invocations.some(isDestructiveLocalInvocation) ? { display: request.display, eligible: true, scope: shellScope(request) } : undefined),
  },
];

function hasUnsafePathEffect(request: NormalizedShellRequest, validator: PathValidator): boolean {
  return ASK_RULES.some((rule) => !["ask-parser-uncertainty", "ask-remote-command-execution", "ask-git-push", "ask-destructive-local"].includes(rule.ruleId) && rule.match(request, validator));
}

function isAllowedGitInvocation(args: string[]): boolean {
  const subcommand = args[0];
  if (!subcommand) return false;
  if (["status", "diff", "log", "show", "blame", "fetch", "pull", "add", "commit"].includes(subcommand)) return true;
  if (subcommand === "stash") return args[1] !== "drop";
  if (subcommand === "branch") return !args.some((arg) => arg === "-D" || arg === "--delete" || arg === "--force");
  if (subcommand === "tag") return args.length === 1 || args[1] === "-l" || args[1] === "--list";
  return false;
}

function isAllowedBunInvocation(args: string[]): boolean {
  if (args.length === 0) return false;
  if (["add", "install", "test"].includes(args[0]!)) return true;
  return args[0] === "run" && Boolean(args[1]);
}

function isAllowedPackageManagerInvocation(name: string, args: string[]): boolean {
  if (name === "bun") return isAllowedBunInvocation(args);
  if (["npm", "pnpm", "yarn"].includes(name)) return args[0] === "install" || (args[0] === "run" && Boolean(args[1]));
  return false;
}

function isAllowedNetworkInvocation(name: string): boolean {
  return ["curl", "wget", "ssh", "scp", "rsync"].includes(name);
}

function isAllowedPackageRunnerInvocation(name: string, request: NormalizedShellRequest, validator: PathValidator): boolean {
  if (!["npx", "bunx"].includes(name)) return false;
  if (request.effects.some((effect) => ["remote-exec", "credential-exfil", "protected-path"].includes(effect.kind))) return false;
  if (hasUnsafePathEffect(request, validator)) return false;
  if (request.invocations.some(hasRemoteShellPayload)) return false;
  return true;
}

function classifyReadOnlyInvocation(invocation: NormalizedShellInvocation, validator: PathValidator, request: NormalizedShellRequest): PermissionDecision {
  const name = invocation.command;
  const args = invocation.argv.slice(1);
  if (!name) return ask("Empty command segment requires confirmation", invocation.display, false, request);

  if (name === "pwd") return args.length === 0 ? allow(invocation.display) : ask("pwd with arguments requires confirmation", invocation.display, true, request);
  if (name === "ls") {
    const paths = pathArgs(args, new Set(["--color", "-I"]));
    return validatePaths(paths, validator) ? allow(invocation.display) : ask("ls path arguments must stay inside workspace", invocation.display, true, request);
  }
  if (["cat", "head", "tail"].includes(name)) {
    if (name === "tail" && args.some((arg) => arg === "-f" || arg === "--follow")) return ask("tail follow mode can block indefinitely", invocation.display, true, request);
    const paths = pathArgs(args, new Set(["-n", "-c", "--lines", "--bytes"]));
    if (paths.length === 0) return ask(`${name} without a file may wait for stdin`, invocation.display, true, request);
    return validatePaths(paths, validator) ? allow(invocation.display) : ask(`${name} path arguments must stay inside workspace`, invocation.display, true, request);
  }
  if (name === "grep" || name === "rg") {
    const positional = pathArgs(args, new Set(["-e", "-f", "--regexp", "--file", "--glob", "-g"]));
    if (positional.length < 2) return ask(`${name} requires explicit path arguments`, invocation.display, true, request);
    return validatePaths(positional.slice(1), validator) ? allow(invocation.display) : ask(`${name} path arguments must stay inside workspace`, invocation.display, true, request);
  }
  if (name === "git") {
    return isAllowedGitInvocation(args) ? allow(invocation.display) : ask("Git command requires confirmation", invocation.display, true, request, "ask-git-command");
  }
  if (isAllowedPackageManagerInvocation(name, args)) return allow(invocation.display);
  if (isAllowedNetworkInvocation(name)) return allow(invocation.display);
  if (isAllowedPackageRunnerInvocation(name, request, validator)) return allow(invocation.display);
  if (COMMON_ALLOWED_COMMANDS.has(name)) return allow(invocation.display);
  return ask("Unknown or mutating command requires confirmation", invocation.display, true, request, "ask-unknown-command");
}

function isParseFailure(value: NormalizedShellRequest | ShellParseFailure): value is ShellParseFailure {
  return "ok" in value && value.ok === false;
}

export function classifyShellRequest(parsed: NormalizedShellRequest | ShellParseFailure, options: ClassifyCommandOptions): PermissionDecision {
  if (isParseFailure(parsed)) return ask(parsed.uncertainty[0]?.reason ?? "Command parse failure requires confirmation", parsed.display, false);

  const request = attachShellEffects(parsed);
  const validator = validateCwd(options);
  if (!validator) return ask("Command cwd must resolve inside workspace", request.display, true, request);

  const decisions: PermissionDecision[] = [];
  if (request.uncertainty.some((item) => item.token === "&")) decisions.push(deny(RULE_REASONS.background, request.display, "deny-background-execution"));
  for (const rule of DENY_RULES) {
    if (rule.matches(request)) decisions.push(deny(rule.reason, request.display, rule.ruleId));
  }
  for (const rule of ASK_RULES) {
    const match = rule.match(request, validator);
    if (match) decisions.push(ask(rule.reason, match.display ?? request.display, match.eligible, request, rule.ruleId, match.scope));
  }
  for (const invocation of request.invocations) {
    decisions.push(classifyReadOnlyInvocation(invocation, validator, request));
  }

  return combinePermissionDecisions(decisions);
}
