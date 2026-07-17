import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { containsSecretPattern } from "../../security/patterns";
import { analyzeBash, type BashAccess, type BashAnalysis, type BashInvocation } from "../security/bash";
import { approvalFingerprint } from "./approval-fingerprint";
import type { PermissionApprovalScope } from "./policy-types";
import { classifySensitivePath } from "./sensitive-file";
import { isProtectedCanonicalWritePath } from "./protected-path";
import type { PermissionDecision, ToolExecutionContext, ToolPermission } from "../types";

const ASK_PROMPT = "Review this bash command before execution.";
const CATASTROPHE_SYSTEM_ROOTS = ["/", "/Users", "/home", "/etc", "/usr", "/bin", "/sbin", "/boot", "/var", "/opt", "/System", "/Library", "/Applications", "/Volumes"];
const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "python", "python3", "node", "ruby", "perl", "bun", "deno"]);
const NETWORK_READERS = new Set(["curl", "wget"]);
const SAFE_DEVICE_PATHS = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/fd/0", "/dev/fd/1", "/dev/fd/2"]);
type GitPathspecMode = NonNullable<BashInvocation["gitPathspecMode"]>;

const SYSTEM_MUTATIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  systemctl: new Set(["start", "stop", "restart", "reload", "enable", "disable", "mask", "unmask", "daemon-reload", "set-default", "edit", "link", "preset", "revert"]),
  launchctl: new Set(["load", "unload", "bootstrap", "bootout", "enable", "disable", "kickstart", "kill", "remove", "submit", "config"]),
  iptables: new Set(["-A", "-D", "-I", "-R", "-F", "-Z", "-N", "-X", "-P", "-E"]),
  nft: new Set(["add", "delete", "insert", "flush", "replace", "reset", "import"]),
  pfctl: new Set(["-e", "-d", "-f", "-F", "-k", "-K", "-x"]),
  ufw: new Set(["enable", "disable", "default", "allow", "deny", "reject", "limit", "delete", "insert", "route", "reset", "reload"]),
  csrutil: new Set(["enable", "disable", "clear", "netboot", "authenticated-root"]),
  spctl: new Set(["--add", "--remove", "--enable", "--disable"]),
};

const UNCONDITIONAL_DISK_DENIES: Readonly<Record<string, ReadonlySet<string>>> = {
  diskutil: new Set(["eraseDisk", "eraseVolume", "zeroDisk", "secureErase", "partitionDisk"]),
  zfs: new Set(["destroy", "rollback"]),
  zpool: new Set(["destroy", "labelclear"]),
  cryptsetup: new Set(["luksFormat", "erase"]),
};

function real(input: string): string {
  try { return realpathSync.native(input); } catch { return path.resolve(input); }
}

function isAtOrBelow(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function catastropheRoots(ctx: ToolExecutionContext): string[] {
  const candidates = [
    ...CATASTROPHE_SYSTEM_ROOTS,
    homedir(),
    ctx.cwd,
    ctx.projectContext.project.workspaceRoot,
  ];
  return [...new Set(candidates.flatMap((candidate) => [path.resolve(candidate), real(candidate)]))];
}

function fixedCatastropheGlobRoot(invocation: BashInvocation, index: number): string | undefined {
  if (!invocation.unquotedPattern[index]) return undefined;
  const token = invocation.argv[index];
  if (token === "/*") return "/";
  if (token === "/Users/*") return "/Users";
  if (token === "*" || token === "./*") return invocation.cwd;
  return undefined;
}

function targetsCatastrophe(
  invocation: BashInvocation,
  roots: readonly string[],
  operation: BashAccess["operation"],
  fixedGlobIndexes: readonly number[],
): boolean {
  if (invocation.accesses.some((access) => access.operation === operation && roots.includes(access.path))) return true;
  return fixedGlobIndexes.some((index) => {
    const expanded = fixedCatastropheGlobRoot(invocation, index);
    return expanded !== undefined && roots.includes(real(expanded));
  });
}

function rmTargetIndexes(invocation: BashInvocation): number[] {
  const indexes: number[] = [];
  let options = true;
  for (let i = 1; i < invocation.argv.length; i += 1) {
    const token = invocation.argv[i]!;
    if (options && token === "--") {
      options = false;
      continue;
    }
    if (options && token.startsWith("-")) continue;
    indexes.push(i);
  }
  return indexes;
}

function denyReason(analysis: BashAnalysis, ctx: ToolExecutionContext): { reason: string; ruleId: string } | undefined {
  if (analysis.hasBackgroundOperator) return { reason: "Background execution with & is not allowed", ruleId: "deny-background" };
  const roots = catastropheRoots(ctx);

  for (const invocation of analysis.invocations) {
    const { command, argv } = invocation;
    for (const access of invocation.accesses) {
      if ((access.operation === "write" || access.operation === "delete") && isProtectedCanonicalWritePath(access.path, ctx)) {
        return { reason: "The .archcode directory and Git metadata are system-managed", ruleId: "deny-protected-path" };
      }
      if (access.operation === "write" && isDangerousDevice(access.path)) {
        return { reason: "Writing to a block device is not allowed", ruleId: "deny-device-write" };
      }
    }

    const rmMode = command === "rm" ? classifyRmMode(argv) : undefined;
    if (rmMode?.recursive && rmMode.forced
      && targetsCatastrophe(invocation, roots, "delete", rmTargetIndexes(invocation))) {
      return { reason: "Recursive forced deletion of a catastrophe root is not allowed", ruleId: "deny-catastrophic-delete" };
    }
    if (command === "find" && invocation.targetOperation === "delete"
      && targetsCatastrophe(invocation, roots, "delete", invocation.targetArgvIndexes ?? [])) {
      return { reason: "Recursive deletion of a catastrophe root is not allowed", ruleId: "deny-catastrophic-find" };
    }
    if (["chmod", "chown"].includes(command) && invocation.recursive
      && targetsCatastrophe(invocation, roots, "write", invocation.targetArgvIndexes ?? [])) {
      return { reason: "Recursive metadata changes on a catastrophe root are not allowed", ruleId: "deny-catastrophic-metadata" };
    }
    if (isManagedGitMutation(invocation)) return { reason: "ArchCode-managed Git state cannot be changed through Bash", ruleId: "deny-managed-git" };
    if (classifyRootWideGitClean(invocation).rootWide) return { reason: "Root-wide git clean is not allowed", ruleId: "deny-root-git-clean" };
    if (isDiskDestructive(invocation)) return { reason: "Destructive disk operation is not allowed", ruleId: "deny-disk-operation" };
    if (isPowerOrProcessDeny(invocation)) return { reason: "System shutdown or global process signaling is not allowed", ruleId: "deny-system-process" };
  }
  return undefined;
}

function classifyRmMode(argv: readonly string[]): { recursive: boolean; forced: boolean } {
  let recursive = false;
  let forced = false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") break;
    if (arg === "--recursive") recursive = true;
    else if (arg === "--force" || arg === "--interactive=never") forced = true;
    else if (arg === "--interactive" || arg === "--interactive=always" || arg === "--interactive=once") forced = false;
    else if (arg.startsWith("-") && !arg.startsWith("--")) {
      for (const flag of arg.slice(1)) {
        if (flag === "r" || flag === "R") recursive = true;
        else if (flag === "f") forced = true;
        else if (flag === "i" || flag === "I") forced = false;
      }
    }
  }
  return { recursive, forced };
}

function isDangerousDevice(filePath: string): boolean {
  if (SAFE_DEVICE_PATHS.has(filePath)) return false;
  if (/^\/dev\/(?:r?disk)/.test(filePath)) return true;
  try { return statSync(filePath).isBlockDevice(); } catch { return false; }
}

function gitSubcommand(invocation: BashInvocation): { subcommand?: string; args: string[]; supported: boolean } {
  if (invocation.gitGlobalShapeSupported !== true) return { args: [], supported: false };
  const index = invocation.gitSubcommandIndex;
  if (index === undefined) return { args: [], supported: true };
  return { subcommand: invocation.argv[index], args: invocation.argv.slice(index + 1), supported: true };
}

function isManagedGitMutation(invocation: BashInvocation): boolean {
  if (invocation.command !== "git") return false;
  const parsed = gitSubcommand(invocation);
  if (parsed.subcommand === "worktree") return classifyManagedWorktree(parsed.args).mutation;
  if (parsed.subcommand === "update-ref") return classifyManagedUpdateRef(parsed.args).mutation;
  return classifyManagedBranchInvocation(invocation).mutation;
}

function isManagedRefName(value: string): boolean {
  return /^(?:refs\/heads\/)?archcode\//.test(value);
}

function classifyManagedUpdateRef(args: readonly string[]): { mutation: boolean; supported: boolean } {
  const operands: string[] = [];
  let deleting = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (["-h", "--help"].includes(arg)) return { mutation: false, supported: true };
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (["-m", "--message"].includes(arg)) {
      if (args[i + 1] === undefined) return { mutation: false, supported: false };
      i += 1;
      continue;
    }
    if (arg.startsWith("--message=")) continue;
    if (["-d", "--delete"].includes(arg)) {
      deleting = true;
      continue;
    }
    if (["--stdin", "-z", "--no-deref", "--create-reflog"].includes(arg)) return { mutation: false, supported: true };
    if (arg.startsWith("-")) return { mutation: false, supported: false };
    operands.push(arg);
  }
  const target = operands[0];
  if (!target || !isManagedRefName(target)) return { mutation: false, supported: true };
  return { mutation: deleting || operands.length >= 2, supported: true };
}

function classifyManagedWorktree(args: readonly string[]): { mutation: boolean; supported: boolean } {
  const mutationVerbs = new Set(["add", "move", "remove", "prune", "repair", "lock", "unlock"]);
  let verb: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (["-h", "--help"].includes(arg)) return { mutation: false, supported: true };
    if (arg === "--") {
      if (verb === undefined) verb = args[i + 1];
      break;
    }
    if (verb === undefined) {
      if (arg.startsWith("-")) return { mutation: false, supported: false };
      verb = arg;
      continue;
    }
    if (["-b", "-B", "--reason", "--expire"].includes(arg)) {
      if (args[i + 1] === undefined) return { mutation: false, supported: false };
      i += 1;
      continue;
    }
    if (/^-[bB].+/.test(arg) || ["--reason=", "--expire="].some((prefix) => arg.startsWith(prefix))) continue;
    if (["-f", "--force", "--detach", "--checkout", "--no-checkout", "--lock", "--quiet", "-n", "--dry-run", "-v", "--verbose"].includes(arg)) continue;
    if (arg.startsWith("-")) return { mutation: false, supported: false };
  }
  return { mutation: mutationVerbs.has(verb ?? ""), supported: true };
}

function classifyManagedBranch(args: readonly string[]): { mutation: boolean; supported: boolean } {
  const operands: string[] = [];
  let action: "create" | "mutation" | "list" = "create";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg === "--set-upstream-to") {
      action = "mutation";
      if (args[i + 1] === undefined) return { mutation: false, supported: false };
      i += 1;
      continue;
    }
    if (arg.startsWith("--set-upstream-to=")) {
      action = "mutation";
      continue;
    }
    if (["--format", "--sort"].includes(arg)) {
      if (args[i + 1] === undefined) return { mutation: false, supported: false };
      i += 1;
      continue;
    }
    if (arg === "--points-at") {
      action = "list";
      if (args[i + 1] === undefined) return { mutation: false, supported: false };
      i += 1;
      continue;
    }
    if (["--contains", "--no-contains", "--merged", "--no-merged"].includes(arg)) {
      action = "list";
      if (args[i + 1] && !args[i + 1]!.startsWith("-")) i += 1;
      continue;
    }
    if (["--delete", "--move", "--copy", "--edit-description", "--unset-upstream"].includes(arg)) {
      action = "mutation";
      continue;
    }
    if (["--no-delete", "--no-move", "--no-copy", "--no-edit-description", "--no-unset-upstream", "--no-set-upstream-to"].includes(arg)) {
      action = "create";
      continue;
    }
    if (["--list", "--show-current", "--all", "--remotes"].includes(arg)) {
      action = "list";
      continue;
    }
    if (["--no-list", "--no-show-current", "--no-points-at"].includes(arg)) {
      action = "create";
      continue;
    }
    if ([
      "--force", "--no-force", "--quiet", "--no-quiet", "--color", "--no-color", "--ignore-case", "--no-ignore-case",
      "--verbose", "--no-verbose", "--abbrev", "--no-abbrev", "--no-track", "--recurse-submodules", "--no-recurse-submodules",
      "--create-reflog", "--no-create-reflog", "--column", "--no-column", "--omit-empty", "--no-omit-empty",
      "--no-sort", "--no-format",
    ].includes(arg)) continue;
    if (arg === "--track") continue;
    if (arg.startsWith("--track=")) {
      if (!["direct", "inherit"].includes(arg.slice("--track=".length))) return { mutation: false, supported: false };
      continue;
    }
    if (["--format=", "--sort=", "--abbrev=", "--no-abbrev=", "--column=", "--no-column=", "--color=", "--no-color="].some((prefix) => arg.startsWith(prefix))) continue;
    if (["--points-at=", "--contains=", "--no-contains=", "--merged=", "--no-merged="].some((prefix) => arg.startsWith(prefix))) {
      action = "list";
      continue;
    }
    if (arg.startsWith("-") && !arg.startsWith("--")) {
      const flags = arg.slice(1);
      for (let offset = 0; offset < flags.length; offset += 1) {
        const flag = flags[offset]!;
        if (flag === "u") {
          action = "mutation";
          if (offset === flags.length - 1) {
            if (args[i + 1] === undefined) return { mutation: false, supported: false };
            i += 1;
          }
          break;
        }
        if (["d", "D", "m", "M", "c", "C"].includes(flag)) action = "mutation";
        else if (["l", "a", "r"].includes(flag)) action = "list";
        else if (!["q", "v", "f", "i", "t"].includes(flag)) return { mutation: false, supported: false };
      }
      continue;
    }
    if (arg.startsWith("-")) return { mutation: false, supported: false };
    operands.push(arg);
  }
  if (action === "list") return { mutation: false, supported: true };
  return { mutation: operands.some(isManagedRefName), supported: true };
}

function classifyManagedBranchInvocation(invocation: BashInvocation): { mutation: boolean; supported: boolean } {
  if (invocation.command !== "git") return { mutation: false, supported: true };
  const parsed = gitSubcommand(invocation);
  if (!parsed.supported) return { mutation: false, supported: false };
  if (parsed.subcommand !== "branch") return { mutation: false, supported: true };
  return classifyManagedBranch(parsed.args);
}

function classifyManagedGitInvocation(invocation: BashInvocation): { mutation: boolean; supported: boolean } {
  if (invocation.command !== "git") return { mutation: false, supported: true };
  const parsed = gitSubcommand(invocation);
  if (!parsed.supported) return { mutation: false, supported: false };
  if (parsed.subcommand === "worktree") return classifyManagedWorktree(parsed.args);
  if (parsed.subcommand === "update-ref") return classifyManagedUpdateRef(parsed.args);
  if (parsed.subcommand === "branch") return classifyManagedBranch(parsed.args);
  return { mutation: false, supported: true };
}

function classifyGitCleanPathspec(candidate: string, mode: GitPathspecMode): "exclude" | "root" | "narrow" {
  if (mode !== "default") return path.posix.normalize(candidate) === "." ? "root" : "narrow";
  const defaultRootPatterns = new Set(["", "*", "**", "**/*", "*/**"]);
  if (candidate === ":" || candidate === ":./") return "root";
  if (candidate.startsWith(":!") || candidate.startsWith(":^")) return "exclude";
  if (candidate.startsWith(":/")) return defaultRootPatterns.has(candidate.slice(2)) ? "root" : "narrow";
  const longMagic = /^:\(([^)]*)\)(.*)$/.exec(candidate);
  if (!longMagic) {
    if (path.posix.normalize(candidate) === ".") return "root";
    const relativePattern = candidate.replace(/^(?:\.\/)+/, "");
    return defaultRootPatterns.has(relativePattern) ? "root" : "narrow";
  }
  const magic = longMagic[1]!.split(",").filter(Boolean);
  const pattern = longMagic[2]!;
  if (magic.some((item) => ["exclude", "!", "^"].includes(item))) return "exclude";
  if (magic.some((item) => item.startsWith("attr:"))) return "narrow";
  if (pattern.length === 0) return "root";
  if (path.posix.resolve("/", pattern) === "/") {
    return magic.includes("top") || magic.some((item) => item.startsWith("prefix:")) ? "narrow" : "root";
  }
  if (magic.includes("literal")) return "narrow";
  if (magic.includes("glob")) return ["**", "**/*", "*/**"].includes(pattern) ? "root" : "narrow";
  return defaultRootPatterns.has(pattern) ? "root" : "narrow";
}

function classifyRootWideGitClean(invocation: BashInvocation): { rootWide: boolean; supported: boolean } {
  if (invocation.command !== "git") return { rootWide: false, supported: true };
  const parsed = gitSubcommand(invocation);
  if (!parsed.supported) return { rootWide: false, supported: false };
  if (parsed.subcommand !== "clean") return { rootWide: false, supported: true };
  const pathspecMode = invocation.gitPathspecMode;
  if (pathspecMode === undefined) return { rootWide: false, supported: false };
  const { args } = parsed;

  let forced = false;
  let directories = false;
  let dryRun = false;
  let interactive = false;
  let options = true;
  const pathspecs: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (options && (arg === "-e" || arg === "--exclude")) {
      if (args[i + 1] === undefined) return { rootWide: false, supported: false };
      i += 1;
      continue;
    }
    if (options && arg.startsWith("--exclude=")) {
      if (arg.length === "--exclude=".length) return { rootWide: false, supported: false };
      continue;
    }
    if (options && arg === "--force") {
      forced = true;
      continue;
    }
    if (options && arg === "--no-force") {
      forced = false;
      continue;
    }
    if (options && arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (options && arg === "--no-dry-run") {
      dryRun = false;
      continue;
    }
    if (options && arg === "--interactive") {
      interactive = true;
      continue;
    }
    if (options && arg === "--no-interactive") {
      interactive = false;
      continue;
    }
    if (options && ["--quiet", "--no-quiet"].includes(arg)) continue;
    if (options && arg.startsWith("--")) return { rootWide: false, supported: false };
    if (options && arg.startsWith("-") && !arg.startsWith("--")) {
      const flags = arg.slice(1);
      for (let offset = 0; offset < flags.length; offset += 1) {
        const flag = flags[offset]!;
        if (flag === "e") {
          if (offset === flags.length - 1) {
            if (args[i + 1] === undefined) return { rootWide: false, supported: false };
            i += 1;
          }
          break;
        }
        if (flag === "f") forced = true;
        else if (flag === "d") directories = true;
        else if (flag === "n") dryRun = true;
        else if (flag === "i") interactive = true;
        else if (!["q", "x", "X"].includes(flag)) return { rootWide: false, supported: false };
      }
      continue;
    }
    pathspecs.push(arg);
  }
  if (dryRun || interactive || !forced || !directories) return { rootWide: false, supported: true };
  if (pathspecs.length === 0) return { rootWide: true, supported: true };
  const positivePathspecs = pathspecs.filter((candidate) => classifyGitCleanPathspec(candidate, pathspecMode) !== "exclude");
  if (positivePathspecs.length === 0) return { rootWide: true, supported: true };
  const rootWide = positivePathspecs.some((candidate) => {
    if (classifyGitCleanPathspec(candidate, pathspecMode) === "root") return true;
    if (candidate.startsWith(":")) return false;
    return real(path.resolve(invocation.cwd, candidate)) === real(invocation.cwd);
  });
  return { rootWide, supported: true };
}

function isDiskDestructive(invocation: BashInvocation): boolean {
  const { command, argv } = invocation;
  let verb = argv[1];
  let verbIndex = 1;
  if (command === "diskutil" && verb === "quiet") {
    verbIndex = 2;
    verb = argv[verbIndex];
  }
  if (command === "cryptsetup") {
    const parsed = cryptsetupVerb(argv.slice(1));
    if (parsed === undefined) return false;
    verb = parsed;
  }
  if (UNCONDITIONAL_DISK_DENIES[command]?.has(verb ?? "")) return true;
  if (command === "diskutil" && verb === "apfs" && ["deleteContainer", "deleteVolume"].includes(argv[verbIndex + 1] ?? "")) return true;
  if (["lvremove", "vgremove", "pvremove"].includes(command)) return true;
  if (command === "mdadm" && argv.includes("--zero-superblock")) return true;
  if (!["mkfs", "wipefs", "blkdiscard", "shred", "badblocks", "fdisk", "gdisk", "parted"].some((name) => command === name || command.startsWith(`${name}.`))) return false;
  return invocation.accesses.some((access) => access.operation === "write" && isDangerousDevice(access.path));
}

function cryptsetupVerb(args: readonly string[]): string | undefined {
  const flags = new Set(["--batch-mode", "-q", "--debug", "--verbose", "--readonly", "--test-passphrase", "--disable-locks"]);
  const values = new Set(["--type", "--cipher", "--key-size", "--hash", "--key-file", "--key-slot", "--pbkdf", "--iter-time", "--timeout", "--tries", "--header", "--label", "--subsystem", "--uuid"]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") return args[i + 1];
    if (flags.has(arg)) continue;
    if (values.has(arg)) {
      i += 1;
      continue;
    }
    if ([...values].some((option) => arg.startsWith(`${option}=`))) continue;
    if (arg.startsWith("-")) return undefined;
    return arg;
  }
  return undefined;
}

function parseSystemctl(args: readonly string[]): { verb?: string; user: boolean; supported: boolean } {
  const supportedFlags = new Set(["--user", "--system", "--global", "--runtime", "--no-block", "--no-wall", "--quiet", "--no-pager", "--plain", "--full"]);
  let user = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") return { verb: args[i + 1], user, supported: true };
    if (supportedFlags.has(arg)) {
      if (arg === "--user") user = true;
      if (arg === "--system") user = false;
      continue;
    }
    if (arg.startsWith("-")) return { user, supported: false };
    return { verb: arg, user, supported: true };
  }
  return { user, supported: true };
}

interface ParsedGlobalVerb {
  verb?: string;
  rest: readonly string[];
  supported: boolean;
  dryRun?: boolean;
  user?: boolean;
}

function parseGlobalVerb(
  args: readonly string[],
  flags: ReadonlySet<string>,
  valueOptions: ReadonlySet<string> = new Set(),
  terminatingOptions: ReadonlySet<string> = new Set(),
): ParsedGlobalVerb {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") return { verb: args[i + 1], rest: args.slice(i + 2), supported: true };
    if (terminatingOptions.has(arg)) return { rest: [], supported: true };
    if (flags.has(arg)) continue;
    if (valueOptions.has(arg)) {
      if (args[i + 1] === undefined) return { rest: [], supported: false };
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) return { rest: [], supported: false };
    return { verb: arg, rest: args.slice(i + 1), supported: true };
  }
  return { rest: [], supported: true };
}

function parseSystemMutation(invocation: BashInvocation): ParsedGlobalVerb {
  const args = invocation.argv.slice(1);
  if (invocation.command === "systemctl") {
    const parsed = parseSystemctl(args);
    return { verb: parsed.verb, rest: [], supported: parsed.supported, user: parsed.user };
  }
  if (["launchctl", "csrutil"].includes(invocation.command)) {
    return parseGlobalVerb(args, new Set());
  }
  if (invocation.command === "security") {
    return parseGlobalVerb(args, new Set(["-i", "-l", "-q", "-v"]), new Set(["-p"]), new Set(["-h"]));
  }
  if (invocation.command === "nft") {
    return parseGlobalVerb(
      args,
      new Set(["-a", "--handle", "-c", "--check", "-e", "--echo", "-j", "--json", "-n", "--numeric", "-s", "--stateless", "-N", "--reversedns", "-t", "--terse", "-S", "--service", "-i", "--interactive"]),
      new Set(["-I", "--includepath", "-f", "--file", "-D", "--define", "-d", "--debug"]),
    );
  }
  if (invocation.command === "ufw") {
    let dryRun = false;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      if (arg === "--") return { verb: args[i + 1], rest: args.slice(i + 2), supported: true, dryRun };
      if (arg === "--force") continue;
      if (arg === "--dry-run") {
        dryRun = true;
        continue;
      }
      if (arg.startsWith("-")) return { rest: [], supported: false };
      return { verb: arg, rest: args.slice(i + 1), supported: true, dryRun };
    }
    return { rest: [], supported: true, dryRun };
  }
  return { verb: args[0], rest: args.slice(1), supported: true };
}

function classifyFixedSystemMutation(invocation: BashInvocation): { mutation: boolean; supported: boolean } {
  const args = invocation.argv.slice(1);
  if (invocation.command === "iptables") {
    const mutationOptions = new Set(["A", "D", "I", "R", "F", "Z", "N", "X", "P", "E"]);
    const mutationValues = new Set(["A", "D", "I", "R", "N", "P", "E"]);
    const valueOptions = new Set(["t", "w", "m", "j", "g"]);
    const flagOptions = new Set(["4", "6", "L", "S", "C", "n", "v", "x"]);
    let mutation = false;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      if (arg === "--") break;
      if (!arg.startsWith("-") || arg === "-") continue;
      if (arg === "--help") return { mutation: false, supported: true };
      if (arg.startsWith("--")) return { mutation: false, supported: false };
      const flags = arg.slice(1);
      for (let offset = 0; offset < flags.length; offset += 1) {
        const option = flags[offset]!;
        if (option === "h") return { mutation: false, supported: true };
        if (mutationOptions.has(option)) {
          mutation = true;
          if (offset < flags.length - 1) break;
          if (mutationValues.has(option)) {
            if (args[i + 1] === undefined) return { mutation: false, supported: false };
            i += 1;
          }
          break;
        }
        if (valueOptions.has(option)) {
          if (offset === flags.length - 1 && args[i + 1] === undefined) return { mutation: false, supported: false };
          if (offset === flags.length - 1) i += 1;
          break;
        }
        if (!flagOptions.has(option)) return { mutation: false, supported: false };
      }
    }
    return { mutation, supported: true };
  }
  if (invocation.command === "pfctl") {
    const mutationFlags = new Set(["e", "d"]);
    const mutationValues = new Set(["f", "F", "k", "K", "x"]);
    const readValues = new Set(["a", "D", "i", "o", "p", "s", "w", "t", "T"]);
    const readFlags = new Set(["A", "g", "l", "h", "m", "N", "n", "O", "q", "R", "r", "v", "z"]);
    let mutation = false;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      if (arg === "--") break;
      if (!arg.startsWith("-") || arg === "-") continue;
      if (arg.startsWith("--")) return { mutation: false, supported: false };
      const flags = arg.slice(1);
      for (let offset = 0; offset < flags.length; offset += 1) {
        const option = flags[offset]!;
        if (option === "h") return { mutation: false, supported: true };
        if (mutationFlags.has(option)) {
          mutation = true;
          continue;
        }
        if (mutationValues.has(option)) {
          if (offset === flags.length - 1 && args[i + 1] === undefined) return { mutation: false, supported: false };
          mutation = true;
          if (offset === flags.length - 1) i += 1;
          break;
        }
        if (readValues.has(option)) {
          if (offset === flags.length - 1 && args[i + 1] === undefined) return { mutation: false, supported: false };
          if (offset === flags.length - 1) i += 1;
          break;
        }
        if (!readFlags.has(option)) return { mutation: false, supported: false };
      }
    }
    return { mutation, supported: true };
  }
  if (invocation.command === "spctl") {
    const mutations = new Set(["--add", "--remove", "--enable", "--disable"]);
    const mutationValues = new Set(["--add", "--remove"]);
    const values = new Set(["--type", "--label", "--context"]);
    const flags = new Set(["--status", "--version", "-v"]);
    let mutation = false;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      if (["--help", "-h"].includes(arg)) return { mutation: false, supported: true };
      const mutationOption = [...mutations].find((option) => arg === option || arg.startsWith(`${option}=`));
      if (mutationOption) {
        mutation = true;
        if (mutationValues.has(mutationOption) && arg === mutationOption) {
          if (args[i + 1] === undefined) return { mutation: false, supported: false };
          i += 1;
        }
        continue;
      }
      if (flags.has(arg) || !arg.startsWith("-")) continue;
      if (values.has(arg)) {
        if (args[i + 1] === undefined) return { mutation: false, supported: false };
        i += 1;
        continue;
      }
      if ([...values].some((option) => arg.startsWith(`${option}=`))) continue;
      return { mutation: false, supported: false };
    }
    return { mutation, supported: true };
  }
  return { mutation: false, supported: true };
}

function isPowerOrProcessDeny(invocation: BashInvocation): boolean {
  const { command, argv } = invocation;
  if (["shutdown", "reboot", "poweroff", "halt"].includes(command)) return true;
  if (command === "init" && ["0", "6"].includes(argv[1] ?? "")) return true;
  const systemctl = command === "systemctl" ? parseSystemctl(argv.slice(1)) : undefined;
  if (systemctl && !systemctl.user && ["poweroff", "reboot", "halt", "kexec"].includes(systemctl.verb ?? "")) return true;
  if (command === "launchctl" && argv[1] === "reboot") return true;
  if (command === "kill") return classifyKill(invocation).globalTarget;
  return false;
}

const VALID_KILL_SIGNAL_NAMES = new Set([
  "HUP", "INT", "QUIT", "ILL", "TRAP", "ABRT", "IOT", "EMT", "FPE", "KILL", "BUS", "SEGV", "SYS", "PIPE",
  "ALRM", "TERM", "URG", "STOP", "TSTP", "CONT", "CHLD", "TTIN", "TTOU", "IO", "XCPU", "XFSZ", "VTALRM",
  "PROF", "WINCH", "INFO", "USR1", "USR2", "POLL",
]);

function parseKillSignal(value: string): number | undefined {
  if (/^\d+$/.test(value)) {
    const signal = Number(value);
    return Number.isSafeInteger(signal) && signal >= 0 && signal <= 64 ? signal : undefined;
  }
  const name = value.toUpperCase().replace(/^SIG/, "");
  return VALID_KILL_SIGNAL_NAMES.has(name) ? 1 : undefined;
}

function classifyKill(invocation: BashInvocation): { globalTarget: boolean; supported: boolean } {
  if (invocation.command !== "kill") return { globalTarget: false, supported: true };
  const targets: string[] = [];
  let signal = 15;
  let signalSpecified = false;
  let options = true;
  for (let i = 1; i < invocation.argv.length; i += 1) {
    const arg = invocation.argv[i]!;
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (options && ["-l", "-L", "--list", "--help"].includes(arg)) return { globalTarget: false, supported: true };
    if (options && ["-s", "-n", "--signal"].includes(arg)) {
      const value = invocation.argv[i + 1];
      if (value === undefined) return { globalTarget: false, supported: false };
      const parsed = parseKillSignal(value);
      if (parsed === undefined) return { globalTarget: false, supported: false };
      signal = parsed;
      signalSpecified = true;
      i += 1;
      continue;
    }
    if (options && arg.startsWith("--signal=")) {
      const parsed = parseKillSignal(arg.slice("--signal=".length));
      if (parsed === undefined) return { globalTarget: false, supported: false };
      signal = parsed;
      signalSpecified = true;
      continue;
    }
    if (options && !signalSpecified && arg.startsWith("-") && arg !== "-") {
      const shorthand = arg.slice(1);
      if (shorthand.startsWith("n") && shorthand.length > 1) {
        const parsed = parseKillSignal(shorthand.slice(1));
        if (parsed === undefined) return { globalTarget: false, supported: false };
        signal = parsed;
        signalSpecified = true;
        continue;
      }
      const parsed = parseKillSignal(shorthand);
      if (parsed === undefined) return { globalTarget: false, supported: false };
      signal = parsed;
      signalSpecified = true;
      continue;
    }
    targets.push(arg);
  }
  if (signal === 0) return { globalTarget: false, supported: true };
  const globalTarget = targets.some((target) => {
    if (!/^[+-]?\d+$/.test(target)) return false;
    const pid = BigInt(target);
    return pid === 1n || pid === 0n || pid === -1n;
  });
  return { globalTarget, supported: true };
}

function isOutsideWorkspace(access: BashAccess, workspaceRoot: string): boolean {
  if (SAFE_DEVICE_PATHS.has(access.path)) return false;
  const root = real(workspaceRoot);
  return !isAtOrBelow(access.path, root);
}

function sensitive(access: BashAccess): boolean {
  return classifySensitivePath({ inputBasename: path.basename(access.path), effectiveCanonicalPath: access.path }).bashCredential;
}

function askReason(analysis: BashAnalysis, ctx: ToolExecutionContext): { reason: string; ruleId: string; persistent: boolean } | undefined {
  const unsupportedPrivilege = analysis.invocations.some((invocation) => invocation.privilege
    && (!invocation.privilegeShapeSupported
      || !isDdPrivilegeShapeSupported(invocation)
      || !parseSystemMutation(invocation).supported
      || !classifyRootWideGitClean(invocation).supported
      || !classifyManagedGitInvocation(invocation).supported
      || !classifyKill(invocation).supported
      || !classifyFixedSystemMutation(invocation).supported));
  if (analysis.invocations.some((invocation) => invocation.privilege)) return { reason: "Privilege escalation or user switching requires confirmation", ruleId: "ask-privilege", persistent: !unsupportedPrivilege };
  if (isDownloadedPipeToInterpreter(analysis)) return { reason: "Downloaded content piped to an interpreter requires confirmation", ruleId: "ask-downloaded-execution", persistent: true };
  for (const invocation of analysis.invocations) {
    if (isSystemMutation(invocation)) return { reason: "System service, firewall, or security mutation requires confirmation", ruleId: "ask-system-mutation", persistent: true };
    if (isCredentialExfiltration(invocation, analysis)) return { reason: "Credential material transfer requires confirmation", ruleId: "ask-credential-transfer", persistent: true };
  }
  if (analysis.accesses.some((access) => access.operation !== "execute" && sensitive(access))) {
    return { reason: "Credential path access requires confirmation", ruleId: "ask-credential-path", persistent: true };
  }
  if (analysis.accesses.some((access) => isOutsideWorkspace(access, ctx.cwd))) return { reason: "Bash path access outside the workspace requires confirmation", ruleId: "ask-outside-workspace", persistent: true };
  return undefined;
}

function isDdPrivilegeShapeSupported(invocation: BashInvocation): boolean {
  if (invocation.command !== "dd") return true;
  if (invocation.dynamic) return false;
  return !invocation.argv.slice(1).some((arg) => ["--help", "--version"].includes(arg));
}

function isDownloadedPipeToInterpreter(analysis: BashAnalysis): boolean {
  return analysis.invocations.some((invocation, index) => NETWORK_READERS.has(invocation.command)
    && analysis.invocations[index + 1]?.separatorBefore === "|"
    && (INTERPRETERS.has(analysis.invocations[index + 1]!.command)
      || INTERPRETERS.has(analysis.invocations[index + 1]!.shellWrapper ?? "")));
}

function isSystemMutation(invocation: BashInvocation): boolean {
  if (invocation.command === "systemctl") {
    const parsed = parseSystemMutation(invocation);
    return parsed.supported && !parsed.user && SYSTEM_MUTATIONS.systemctl!.has(parsed.verb ?? "");
  }
  if (["launchctl", "csrutil"].includes(invocation.command)) {
    const parsed = parseSystemMutation(invocation);
    return parsed.supported && SYSTEM_MUTATIONS[invocation.command]!.has(parsed.verb ?? "");
  }
  if (["nft", "ufw"].includes(invocation.command)) {
    const parsed = parseSystemMutation(invocation);
    return parsed.supported && !parsed.dryRun && SYSTEM_MUTATIONS[invocation.command]!.has(parsed.verb ?? "");
  }
  if (["iptables", "pfctl", "spctl"].includes(invocation.command)) {
    return classifyFixedSystemMutation(invocation).mutation;
  }
  if (invocation.command === "security") {
    const parsed = parseSystemMutation(invocation);
    if (!parsed.supported) return false;
    const verb = parsed.verb ?? "";
    return /^(?:add-|delete-|set-)/.test(verb) || ["create-keychain", "unlock-keychain"].includes(verb)
      || (verb === "authorizationdb" && ["write", "remove"].includes(parsed.rest[0] ?? ""));
  }
  return false;
}

function isCredentialExfiltration(invocation: BashInvocation, analysis: BashAnalysis): boolean {
  const sensitiveReads = invocation.accesses.filter((access) => access.operation === "read" && sensitive(access));
  if (sensitiveReads.length === 0) return false;
  if (["curl", "wget"].includes(invocation.command)) return true;
  if (["scp", "rsync"].includes(invocation.command)) return invocation.remoteDestination === true;
  if (["nc", "netcat"].includes(invocation.command)) return true;
  const index = analysis.invocations.indexOf(invocation);
  let pipelineStart = index;
  let pipelineEnd = index;
  while (pipelineStart > 0 && analysis.invocations[pipelineStart]?.separatorBefore === "|") pipelineStart -= 1;
  while (analysis.invocations[pipelineEnd + 1]?.separatorBefore === "|") pipelineEnd += 1;
  return analysis.invocations.slice(pipelineStart, pipelineEnd + 1).some((candidate) => ["nc", "netcat"].includes(candidate.command));
}

function exactScope(analysis: BashAnalysis): PermissionApprovalScope {
  return {
    kind: "bash-exact",
    command: analysis.command,
    cwd: analysis.cwd,
    accesses: analysis.accesses,
  };
}

function ask(analysis: BashAnalysis, match: { reason: string; ruleId: string; persistent: boolean }): PermissionDecision {
  const containsSecret = containsSecretPattern(analysis.command).found;
  const eligible = match.persistent && !analysis.hasDynamicReferences && !containsSecret;
  const display = containsSecret ? "Bash command contains sensitive content" : analysis.command;
  const scope = exactScope(analysis);
  return {
    outcome: "ask",
    reason: match.reason,
    prompt: ASK_PROMPT,
    source: "builtin-policy",
    ruleId: match.ruleId,
    display,
    approval: {
      eligible,
      ...(eligible ? { scope } : { fingerprint: approvalFingerprint(scope) }),
      display,
      reason: match.reason,
    },
  };
}

export function createBashPermission(): ToolPermission {
  return (input: unknown, ctx: ToolExecutionContext): PermissionDecision => {
    if (!input || typeof input !== "object" || !("command" in input) || typeof input.command !== "string") {
      const reason = "Bash permission requires a command string";
      return { outcome: "ask", reason, prompt: ASK_PROMPT, approval: { eligible: false, display: "Invalid Bash command", reason } };
    }
    const cwd = "cwd" in input && typeof input.cwd === "string" ? input.cwd : undefined;
    const analysis = analyzeBash(input.command, { workspaceRoot: ctx.cwd, cwd });
    const denied = denyReason(analysis, ctx);
    if (denied) return { outcome: "deny", ...denied, source: "builtin-policy", display: analysis.command };
    const asked = askReason(analysis, ctx);
    if (asked) return ask(analysis, asked);
    return { outcome: "allow", source: "builtin-policy", display: analysis.command };
  };
}
