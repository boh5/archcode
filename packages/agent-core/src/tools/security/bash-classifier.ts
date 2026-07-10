import { parseShellRequest } from "./bash/parse";
import { classifyShellRequest, type ClassifyCommandOptions } from "./bash/policy";
import type { PermissionDecision } from "../types";

export type { ClassifyCommandOptions } from "./bash/policy";
export { parseShellRequest, attachShellEffects, classifyShellRequest, deriveShellApprovalScope } from "./bash";

interface RawDenyRule {
  ruleId: string;
  reason: string;
  pattern: RegExp;
}

const RAW_DENY_RULES: RawDenyRule[] = [
  { ruleId: "deny-privilege-escalation", reason: "Privilege escalation or user switching is blocked", pattern: /(^|[^\w.-])(sudo|su|doas|pkexec|runuser)([^\w.-]|$)|(^|[^\w.-])machinectl\s+shell\b|(^|[^\w.-])osascript\b[^\n]*(with administrator privileges)/ },
  { ruleId: "deny-remote-exec", reason: "Downloaded content executed by an interpreter is blocked", pattern: /(^|[^\w.-])(curl|wget|fetch|http)\b[^\n|;]*\|\s*(sh|bash|zsh|python|python3|node|ruby|perl)\b|\beval\s+["']?\$\((curl|wget|fetch|http)\b|\b(source|\.|bash|sh|zsh)\s+<\s*\((curl|wget|fetch|http)\b|\b(sh|bash|zsh)\s+-c\s+["'][^"']*(curl|wget|fetch|http)\b/ },
  { ruleId: "deny-catastrophic-delete", reason: "Catastrophic deletion of system paths is blocked", pattern: /(^|[^\w.-])rm\s+[^\n;&|]*-(?:[^\s;&|]*r[^\s;&|]*f|[^\s;&|]*f[^\s;&|]*r)[^\n;&|]*(\s|^)(\/|~|\$HOME|\$\{HOME\}|\/Users|\/home|\/etc|\/usr|\/bin|\/sbin|\/var|\/opt|\/System|\/Library|\/Applications)(\s|\/|$)|(^|[^\w.-])find\s+(\/|~|\$HOME|\$\{HOME\})\b[^\n;&|]*(-delete|-exec\s+rm\b)/ },
  { ruleId: "deny-disk-filesystem-destructive", reason: "Disk, filesystem, or device destructive command is blocked", pattern: /(^|[^\w.-])dd\b[^\n;&|]*\bof=\/dev\/|(^|[^\w.-])(mkfs(?:\.[\w-]+)?|fdisk|gdisk|parted)\b|(^|[^\w.-])diskutil\s+erase\w*\b|(^|[^\w.-])(zfs|zpool)\s+(destroy|create|labelclear|rollback|receive|remove|replace)\b|(^|[^\w.-])cryptsetup\s+(luksFormat|erase|remove|resize|reencrypt)\b/ },
  { ruleId: "deny-system-service-security-write", reason: "System service, firewall, or security setting writes are blocked", pattern: /(^|[^\w.-])launchctl\s+(bootstrap|bootout|enable|disable|kickstart|load|unload|remove|submit|setenv|unsetenv)\b|(^|[^\w.-])systemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload|set-property)\b|(^|[^\w.-])(iptables|nft|csrutil)\b|(^|[^\w.-])pfctl\b[^\n;&|]*\s(-f|-e|-d)\b|(^|[^\w.-])ufw\s+(enable|disable)\b|(^|[^\w.-])security\s+(add|delete|set|unlock|lock|import|create|authorize|default-keychain)\b|(^|[^\w.-])spctl\b[^\n;&|]*(--master-disable|--master-enable|--add|--remove|--enable|--disable)/ },
  { ruleId: "deny-credential-exfiltration", reason: "Credential material exfiltration is blocked", pattern: /(\.env(?:\.[\w.-]+)?|\.ssh\/|\.aws\/|\.config\/gcloud\/|\.azure\/)[^\n;&|]*(curl|wget|scp|rsync|nc|netcat)|(^|[^\w.-])tar\b[^\n;&|]*(\.env|\.ssh|\.aws|\.config\/gcloud|\.azure)[^\n]*\|\s*(curl|wget|nc|netcat|ssh)\b/ },
  { ruleId: "deny-protected-permissions-file", reason: "Protected permission file access is blocked", pattern: /(?:\.\/)?\.archcode\/permissions\.json/ },
  { ruleId: "deny-direct-path-mutation", reason: "Direct mutation of .archcode is blocked", pattern: /(^|[^\w.-])(rm|mv|cp|tee|mkdir|touch|chmod|chown)\b[^\n;&|]*\.archcode(\/|\s|$)|(^|[^\w.-])git\s+clean\b[^\n;&|]*\.archcode(\/|\s|$)|(^|\s)(>|>>|2>|2>>|&>|&>>)\s*\.archcode\// },
  { ruleId: "deny-direct-worktree-command", reason: "Git worktree enumeration and lifecycle commands are blocked for Agents; use ArchCode worktree capabilities", pattern: /(^|[^\w.-])git\b[^\n;&|]*\bworktree(?:\s|$)/ },
  { ruleId: "deny-managed-worktree-ref-mutation", reason: "ArchCode-managed worktree refs can be changed only by ArchCode worktree management", pattern: /(^|[^\w.-])git\b[^\n;&|]*\b(branch|update-ref)\b[^\n;&|]*(refs\/heads\/)?archcode\// },
];

function findRawDeny(command: string): RawDenyRule | undefined {
  return RAW_DENY_RULES.find((rule) => rule.pattern.test(command));
}

export function classifyCommand(command: string, options: ClassifyCommandOptions): PermissionDecision {
  const trimmed = command.trim();
  const parsed = parseShellRequest(command, options);
  if (!("ok" in parsed && parsed.ok === false)) {
    return classifyShellRequest(parsed, options);
  }
  const rawDeny = findRawDeny(trimmed);
  if (rawDeny) return { outcome: "deny", reason: rawDeny.reason, source: "builtin-policy", ruleId: rawDeny.ruleId, display: trimmed };
  return classifyShellRequest(parsed, options);
}
