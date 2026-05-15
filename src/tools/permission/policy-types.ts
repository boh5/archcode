export type ShellEffectKind =
  | "read"
  | "write"
  | "delete"
  | "network"
  | "remote-exec"
  | "credential-exfil"
  | "system-mutation"
  | "protected-specra"
  | "parser-uncertain"
  | "execute-code";

export interface ShellRedirection {
  kind: "stdin" | "stdout" | "stderr" | "stdout-stderr";
  operation: "read" | "write" | "append";
  target: string;
  fd?: number;
}

export interface ShellPathReference {
  path: string;
  operation: "read" | "write" | "delete" | "execute" | "unknown";
  source: "argument" | "redirection" | "command";
}

export interface ShellEffect {
  kind: ShellEffectKind;
  target?: string;
  reason: string;
}

export interface ShellUncertainty {
  kind: "parse" | "expansion" | "substitution" | "unknown-command";
  reason: string;
  token?: string;
}

export interface NormalizedShellInvocation {
  command: string;
  argv: string[];
  cwd: string;
  segmentIndex: number;
  separatorBefore?: "&&" | "||" | ";" | "|";
  redirections: ShellRedirection[];
  paths: ShellPathReference[];
  effects: ShellEffect[];
  uncertainty: ShellUncertainty[];
  display: string;
}

export interface NormalizedShellRequest {
  raw: string;
  cwd: string;
  invocations: NormalizedShellInvocation[];
  effects: ShellEffect[];
  uncertainty: ShellUncertainty[];
  display: string;
}

export type PermissionApprovalScope =
  | { kind: "tool-operation"; toolName: string; operation: string; target?: string }
  | {
      kind: "file-path";
      operation: "read" | "write" | "edit" | "delete";
      path: string;
      pathMode: "exact" | "subtree";
    }
  | {
      kind: "bash-command";
      command: string;
      subcommands: string[];
      argumentMode: "exact" | "any";
      effects: ShellEffectKind[];
    }
  | { kind: "bash-exact"; normalized: string; effects: ShellEffectKind[] }
  | { kind: "web-origin"; origin: string };

export interface PermissionApprovalRequest {
  eligible: boolean;
  scope?: PermissionApprovalScope;
  display: string;
  reason: string;
}
