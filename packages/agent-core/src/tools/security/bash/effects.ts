import { normalize } from "node:path";
import { PROJECT_STATE_DIR_NAME } from "@archcode/protocol";
import type { NormalizedShellInvocation, NormalizedShellRequest, ShellEffect } from "../../permission/policy-types";

const PRIVILEGE_ESCALATION_COMMANDS = new Set(["sudo", "su", "doas", "pkexec", "runuser"]);
const NETWORK_COMMANDS = new Set(["curl", "wget", "fetch", "http", "ssh", "scp", "rsync", "nc", "netcat"]);
const DOWNLOAD_COMMANDS = new Set(["curl", "wget", "fetch", "http"]);
const SHELL_EXECUTORS = new Set(["sh", "bash", "zsh", "python", "python3", "node", "ruby", "perl"]);
const CREDENTIAL_PATH_PATTERNS = [/^\.env(?:\..*)?$/, /(?:^|\/)\.env(?:\..*)?$/, /(?:^|\/)\.ssh(?:\/|$)/, /(?:^|\/)\.aws(?:\/|$)/, /(?:^|\/)\.config\/gcloud(?:\/|$)/, /(?:^|\/)\.azure(?:\/|$)/];
const CATASTROPHIC_DELETE_TARGETS = new Set(["/", "~", "$HOME", "${HOME}", "/Users", "/home", "/etc", "/usr", "/bin", "/sbin", "/var", "/opt", "/System", "/Library", "/Applications"]);
const SPEC_LINKED_MUTATORS = new Set(["rm", "mv", "cp", "tee", "mkdir", "touch", "chmod", "chown"]);
const CREDENTIAL_EXFIL_COMMANDS = new Set(["curl", "wget", "scp", "rsync", "nc", "netcat"]);
const SECURITY_WRITE_COMMANDS = new Set(["iptables", "nft", "csrutil"]);
const PROJECT_DIR_TEXT_PATTERN = new RegExp(`(^|[^A-Za-z0-9._-])(?:\\./)?${escapeRegExp(PROJECT_STATE_DIR_NAME)}(?=$|[^A-Za-z0-9._-])`);
const INLINE_PROJECT_MUTATION_PATTERN = /\b(?:rmtree|remove|unlink|rmdir|rmSync|unlinkSync|rmdirSync|writeFile|writeFileSync|writeText|write_text|mkdir|mkdirSync|rename|renameSync|chmod|chmodSync|chown|chownSync|copyFile|copyFileSync)\b|\bopen\s*\([^)]*,\s*["'][^"']*[wax+]/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function effect(kind: ShellEffect["kind"], reason: string, target?: string): ShellEffect {
  return target === undefined ? { kind, reason } : { kind, reason, target };
}

function argAfter(argv: string[], option: string): string | undefined {
  const index = argv.indexOf(option);
  return index >= 0 ? argv[index + 1] : undefined;
}

function isProjectPath(rawPath: string): boolean {
  const normalized = normalize(rawPath);
  return normalized === PROJECT_STATE_DIR_NAME || normalized.startsWith(`${PROJECT_STATE_DIR_NAME}/`) || normalized.includes(`/${PROJECT_STATE_DIR_NAME}/`) || normalized.endsWith(`/${PROJECT_STATE_DIR_NAME}`);
}

function isPermissionsPath(rawPath: string): boolean {
  const normalized = normalize(rawPath);
  const permissionsPath = `${PROJECT_STATE_DIR_NAME}/permissions.json`;
  return normalized === permissionsPath || normalized.endsWith(`/${permissionsPath}`);
}

function hasCredentialPath(argv: string[]): boolean {
  return argv.some((arg) => {
    const candidates = [arg, arg.replace(/^~/, ""), arg.replace(/^@/, ""), arg.replace(/^[^=]+=@?/, "")];
    return candidates.some((candidate) => CREDENTIAL_PATH_PATTERNS.some((pattern) => pattern.test(candidate)));
  });
}

function hasCredentialExfil(invocation: NormalizedShellInvocation, next?: NormalizedShellInvocation): boolean {
  const credentialInArgs = hasCredentialPath(invocation.argv);
  const credentialInReadRedirection = invocation.redirections.some((redirection) => redirection.operation === "read" && hasCredentialPath([redirection.target]));
  return (credentialInArgs && CREDENTIAL_EXFIL_COMMANDS.has(invocation.command)) || (credentialInReadRedirection && CREDENTIAL_EXFIL_COMMANDS.has(invocation.command)) || (credentialInArgs && invocation.command === "tar" && next?.separatorBefore === "|" && CREDENTIAL_EXFIL_COMMANDS.has(next.command));
}

function hasCatastrophicTarget(argv: string[]): boolean {
  return argv.slice(1).some((arg) => CATASTROPHIC_DELETE_TARGETS.has(arg.replace(/\/+$/, "") || "/"));
}

function hasFindDelete(invocation: NormalizedShellInvocation): boolean {
  return invocation.command === "find" && hasCatastrophicTarget(invocation.argv) && invocation.argv.includes("-delete");
}

function hasFindExecRm(invocation: NormalizedShellInvocation): boolean {
  return invocation.command === "find" && invocation.argv.includes("-exec") && invocation.argv.some((arg) => arg === "rm" || arg.endsWith("/rm"));
}

function isDestructiveDiskCommand(invocation: NormalizedShellInvocation): boolean {
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

function isSecurityWriteCommand(invocation: NormalizedShellInvocation): boolean {
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

function isMacOsAdminOsaScript(invocation: NormalizedShellInvocation): boolean {
  return invocation.command === "osascript" && invocation.argv.join(" ").includes("with administrator privileges");
}

function isRemoteDownloadCommand(invocation: NormalizedShellInvocation): boolean {
  return DOWNLOAD_COMMANDS.has(invocation.command) || invocation.argv.some((arg) => /^https?:\/\//.test(arg));
}

function inlineScriptPayload(invocation: NormalizedShellInvocation): string | undefined {
  if (["python", "python3", "node", "ruby", "perl"].includes(invocation.command)) {
    return argAfter(invocation.argv, "-c") ?? argAfter(invocation.argv, "-e");
  }
  if (["sh", "bash", "zsh"].includes(invocation.command)) {
    return argAfter(invocation.argv, "-c");
  }
  return undefined;
}

function mutatesProjectPathFromInlineScript(invocation: NormalizedShellInvocation): boolean {
  const payload = inlineScriptPayload(invocation);
  return Boolean(payload && PROJECT_DIR_TEXT_PATTERN.test(payload) && INLINE_PROJECT_MUTATION_PATTERN.test(payload));
}

function invocationEffects(invocation: NormalizedShellInvocation, next?: NormalizedShellInvocation): ShellEffect[] {
  const effects: ShellEffect[] = [];
  const command = invocation.command;

  for (const path of invocation.paths) {
    if (isPermissionsPath(path.path)) {
      effects.push(effect("protected-path", "Protected permission file access is blocked", path.path));
    } else if (isProjectPath(path.path) && path.operation !== "read") {
      effects.push(effect("protected-path", "Direct mutation of .archcode is blocked", path.path));
    }
    if (path.operation === "read") effects.push(effect("read", "Command reads a path", path.path));
    if (path.operation === "write") effects.push(effect("write", "Command writes a path", path.path));
    if (path.operation === "delete") effects.push(effect("delete", "Command deletes a path", path.path));
    if (path.operation === "execute") effects.push(effect("execute-code", "Command executes a path", path.path));
  }

  for (const redirection of invocation.redirections) {
    if (redirection.operation === "read") effects.push(effect("read", "Command reads stdin redirection", redirection.target));
    else effects.push(effect("write", "Command writes redirection", redirection.target));
  }

  if (PRIVILEGE_ESCALATION_COMMANDS.has(command) || (command === "machinectl" && invocation.argv[1] === "shell") || isMacOsAdminOsaScript(invocation)) {
    effects.push(effect("system-mutation", "Privilege escalation or user switching is blocked"));
  }
  if (isDestructiveDiskCommand(invocation)) effects.push(effect("system-mutation", "Disk, filesystem, or device destructive command is blocked"));
  if (isSecurityWriteCommand(invocation)) effects.push(effect("system-mutation", "System service, firewall, or security setting write is blocked"));
  if (command === "rm") effects.push(effect("delete", "rm deletes paths"));
  if (command === "rm" && hasRecursiveForce(invocation.argv) && hasCatastrophicTarget(invocation.argv)) {
    effects.push(effect("system-mutation", "Catastrophic deletion of a system path is blocked"));
  }
  if (hasFindDelete(invocation) || hasFindExecRm(invocation)) effects.push(effect("system-mutation", "Catastrophic find deletion is blocked"));
  if (command === "chmod" && invocation.argv.slice(1).includes("777")) effects.push(effect("system-mutation", "Dangerous chmod 777 command is blocked"));
  if (NETWORK_COMMANDS.has(command)) effects.push(effect("network", `${command} performs network I/O`));
  if (isRemoteDownloadCommand(invocation) && next?.separatorBefore === "|" && SHELL_EXECUTORS.has(next.command)) {
    effects.push(effect("remote-exec", "Downloaded content piped to an interpreter is blocked"));
  }
  if (SHELL_EXECUTORS.has(command) && invocation.argv.some((arg) => /^https?:\/\//.test(arg))) {
    effects.push(effect("remote-exec", "Interpreter execution of remote content is blocked"));
  }
  if (["eval", "source", "."].includes(command) && invocation.argv.some((arg) => /https?:\/\//.test(arg) || /curl|wget|fetch|http/.test(arg))) {
    effects.push(effect("remote-exec", "Downloaded content evaluated by shell is blocked"));
  }
  if (["sh", "bash", "zsh"].includes(command) && invocation.argv.includes("-c") && /https?:\/\//.test(argAfter(invocation.argv, "-c") ?? "")) {
    effects.push(effect("remote-exec", "Shell -c execution of downloaded content is blocked"));
  }
  if (hasCredentialExfil(invocation, next)) {
    effects.push(effect("credential-exfil", "Credential material exfiltration is blocked"));
  }
  if (SPEC_LINKED_MUTATORS.has(command) && invocation.argv.some(isProjectPath)) {
    effects.push(effect("protected-path", "Direct mutation of .archcode is blocked"));
  }
  if (command === "git" && invocation.argv[1] === "clean" && invocation.argv.some(isProjectPath)) {
    effects.push(effect("protected-path", "Direct mutation of .archcode is blocked"));
  }
  if (mutatesProjectPathFromInlineScript(invocation)) {
    effects.push(effect("protected-path", "Inline script mutation of .archcode is blocked", PROJECT_STATE_DIR_NAME));
  }
  if (["sh", "bash", "zsh", "eval", "source", ".", "npx", "bunx"].includes(command)) effects.push(effect("execute-code", `${command} may execute code`));
  for (const uncertain of invocation.uncertainty) effects.push(effect("parser-uncertain", uncertain.reason, uncertain.token));

  return effects;
}

export function attachShellEffects(request: NormalizedShellRequest): NormalizedShellRequest {
  const invocations = request.invocations.map((invocation, index) => ({
    ...invocation,
    effects: invocationEffects(invocation, request.invocations[index + 1]),
  }));
  return {
    ...request,
    invocations,
    effects: [...invocations.flatMap((invocation) => invocation.effects), ...request.uncertainty.map((item) => effect("parser-uncertain", item.reason, item.token))],
  };
}
