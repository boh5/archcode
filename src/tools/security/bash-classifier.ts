import path from "node:path";
import type { PermissionDecision } from "../types";
import { PathValidator } from "./path-validator";

/**
 * Combine multiple permission decisions using priority: deny > ask > allow.
 * Inlined here to avoid security → permission reverse dependency.
 */
function combinePermissionDecisions(decisions: PermissionDecision[]): PermissionDecision {
  if (decisions.length === 0) return { outcome: "allow" };
  for (const decision of decisions) {
    if (decision.outcome === "deny") return decision;
  }
  for (const decision of decisions) {
    if (decision.outcome === "ask") return decision;
  }
  return { outcome: "allow" };
}

interface ClassifyCommandOptions {
  workspaceRoot: string;
  cwd?: string;
}

interface Token {
  value: string;
  quoted: boolean;
}

type SegmentSeparator = "&&" | "||" | ";" | "|";

interface Segment {
  tokens: Token[];
  separatorBefore?: SegmentSeparator;
}

interface ScanResult {
  segments: Segment[];
  hasUntrustedSyntax: boolean;
  hasBackgroundOperator: boolean;
  substitutionCommands: string[];
}

const ASK: PermissionDecision = {
  outcome: "ask",
  reason: "Command requires user confirmation",
  prompt: "Review this bash command before execution.",
};

const DENY_TOKENS = new Set([
  "sudo",
  "su",
  "chown",
  "kill",
  "pkill",
  "launchctl",
  "dd",
  "mkfs",
  "diskutil",
]);

const SHELL_TOKENS = new Set(["sh", "bash", "zsh", "ksh", "dash"]);
const WRITE_REDIRECTION_RE = /(^|[^<])>{1,2}|&>|\d>{1,2}/;

function deny(reason: string): PermissionDecision {
  return { outcome: "deny", reason };
}

function ask(reason: string): PermissionDecision {
  return { outcome: "ask", reason, prompt: "Review this bash command before execution." };
}

function allow(): PermissionDecision {
  return { outcome: "allow" };
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function hasDangerousRawToken(command: string): boolean {
  const rawChecks = [
    /(^|[^\w.-])sudo([^\w.-]|$)/,
    /(^|[^\w.-])su([^\w.-]|$)/,
    /(^|[^\w.-])chown([^\w.-]|$)/,
    /(^|[^\w.-])kill([^\w.-]|$)/,
    /(^|[^\w.-])pkill([^\w.-]|$)/,
    /(^|[^\w.-])launchctl([^\w.-]|$)/,
    /(^|[^\w.-])dd([^\w.-]|$)/,
    /(^|[^\w.-])mkfs([^\w.-]|$)/,
    /(^|[^\w.-])diskutil([^\w.-]|$)/,
    /(^|[^\w.-])rm\s+[^\n;&|]*-(?:[^\s;&|]*r[^\s;&|]*f|[^\s;&|]*f[^\s;&|]*r)/,
    /(^|[^\w.-])rm\s+[^\n;&|]*--recursive\s+[^\n;&|]*--force/,
    /(^|[^\w.-])rm\s+[^\n;&|]*--force\s+[^\n;&|]*--recursive/,
    /(^|[^\w.-])chmod\s+[^\n;&|]*777([^0-9]|$)/,
    /(^|[^\w.-])(curl|wget)\b[^\n]*\|\s*(sh|bash)\b/,
  ];
  return rawChecks.some((check) => check.test(command));
}

function scanCommand(command: string): ScanResult | undefined {
  const segments: Segment[] = [{ tokens: [] }];
  const substitutionCommands: string[] = [];
  let token = "";
  let tokenQuoted = false;
  let quote: "single" | "double" | undefined;
  let escaped = false;
  let hasUntrustedSyntax = false;
  let hasBackgroundOperator = false;

  const currentSegment = (): Segment => segments[segments.length - 1]!;
  const pushToken = () => {
    if (token.length > 0 || tokenQuoted) {
      currentSegment().tokens.push({ value: token, quoted: tokenQuoted });
      token = "";
      tokenQuoted = false;
    }
  };
  const pushSegment = (separatorBefore: SegmentSeparator) => {
    pushToken();
    segments.push({ tokens: [], separatorBefore });
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;

    if (escaped) {
      token += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }

    if (quote === "single") {
      if (ch === "'") quote = undefined;
      else token += ch;
      continue;
    }

    if (quote === "double") {
      if (ch === '"') {
        quote = undefined;
        continue;
      }
      if (ch === "`" || ch === "$" && command[i + 1] === "(") {
        hasUntrustedSyntax = true;
        if (ch === "$") {
          const extracted = extractSubstitution(command, i + 2);
          if (extracted) substitutionCommands.push(extracted.content);
        }
      }
      token += ch;
      continue;
    }

    if (ch === "'") {
      tokenQuoted = true;
      quote = "single";
      continue;
    }
    if (ch === '"') {
      tokenQuoted = true;
      quote = "double";
      continue;
    }
    if (ch === "`") {
      hasUntrustedSyntax = true;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      hasUntrustedSyntax = true;
      const extracted = extractSubstitution(command, i + 2);
      if (extracted) {
        substitutionCommands.push(extracted.content);
        i = extracted.endIndex;
      }
      continue;
    }
    if (ch === "(" || ch === ")") {
      hasUntrustedSyntax = true;
      continue;
    }
    if (ch === "<") {
      hasUntrustedSyntax = true;
      token += ch;
      continue;
    }
    if (ch === ">") {
      hasUntrustedSyntax = true;
      token += ch;
      continue;
    }
    if (isWhitespace(ch)) {
      pushToken();
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      pushSegment("&&");
      i += 1;
      continue;
    }
    if (ch === "&") {
      if (command[i + 1] === ">" || command[i - 1] === ">" || command[i - 1] === "<") {
        hasUntrustedSyntax = true;
        token += ch;
        continue;
      }
      hasBackgroundOperator = true;
      continue;
    }
    if (ch === "|" && command[i + 1] === "|") {
      pushSegment("||");
      i += 1;
      continue;
    }
    if (ch === "|") {
      pushSegment("|");
      continue;
    }
    if (ch === ";") {
      pushSegment(";");
      continue;
    }
    token += ch;
  }

  if (escaped || quote) return undefined;
  pushToken();
  return { segments, hasUntrustedSyntax, hasBackgroundOperator, substitutionCommands };
}

function extractSubstitution(command: string, startIndex: number): { content: string; endIndex: number } | undefined {
  let depth = 1;
  let quote: "single" | "double" | undefined;
  let escaped = false;

  for (let i = startIndex; i < command.length; i += 1) {
    const ch = command[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }
    if (quote === "single") {
      if (ch === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      if (ch === '"') quote = undefined;
      continue;
    }
    if (ch === "'") {
      quote = "single";
      continue;
    }
    if (ch === '"') {
      quote = "double";
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { content: command.slice(startIndex, i), endIndex: i };
    }
  }
  return undefined;
}

function normalizeCommandName(value: string): string {
  return path.basename(value);
}

function segmentHasWriteRedirection(segment: Segment): boolean {
  return segment.tokens.some((token) => WRITE_REDIRECTION_RE.test(token.value));
}

function classifyDangerousSegment(segment: Segment, nextSegment?: Segment): PermissionDecision | undefined {
  const command = segment.tokens[0];
  if (!command) return undefined;
  const name = normalizeCommandName(command.value);
  const args = segment.tokens.slice(1).map((token) => token.value);

  if (DENY_TOKENS.has(name) || name.startsWith("mkfs.")) return deny(`Dangerous command is blocked: ${name}`);
  if (name === "rm" && hasRecursiveForce(args)) return deny("Dangerous rm -rf command is blocked");
  if (name === "chmod" && args.includes("777")) return deny("Dangerous chmod 777 command is blocked");
  if ((name === "curl" || name === "wget") && nextSegment?.separatorBefore === "|") {
    const pipedName = nextSegment.tokens[0]?.value;
    if (pipedName && SHELL_TOKENS.has(normalizeCommandName(pipedName))) {
      return deny(`Dangerous ${name} pipe to shell is blocked`);
    }
  }
  return undefined;
}

function hasRecursiveForce(args: string[]): boolean {
  let recursive = false;
  let force = false;
  for (const arg of args) {
    if (arg === "--recursive") recursive = true;
    if (arg === "--force") force = true;
    if (arg.startsWith("-") && !arg.startsWith("--")) {
      recursive ||= arg.includes("r") || arg.includes("R");
      force ||= arg.includes("f");
    }
  }
  return recursive && force;
}

function validateCwd(options: ClassifyCommandOptions): PathValidator | undefined {
  const rootValidator = new PathValidator(options.workspaceRoot);
  if (!options.cwd) return rootValidator;
  const cwdResult = rootValidator.validate(options.cwd);
  if (!cwdResult.ok) return undefined;
  return new PathValidator(cwdResult.resolvedPath);
}

function isOptionLike(value: string): boolean {
  return value.startsWith("-");
}

function pathArgs(tokens: Token[], optionsWithValues = new Set<string>()): Token[] | undefined {
  const paths: Token[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (isOptionLike(token.value)) {
      if (optionsWithValues.has(token.value)) i += 1;
      continue;
    }
    paths.push(token);
  }
  return paths;
}

function validatePaths(tokens: Token[], validator: PathValidator): boolean {
  return tokens.every((token) => !token.quoted && validator.validate(token.value).ok);
}

function classifyReadOnlySegment(segment: Segment, validator: PathValidator): PermissionDecision {
  const command = segment.tokens[0];
  if (!command) return ask("Empty command segment requires confirmation");
  const name = normalizeCommandName(command.value);
  const args = segment.tokens.slice(1);

  if (name === "pwd") return args.length === 0 ? allow() : ask("pwd with arguments requires confirmation");

  if (name === "ls") {
    const paths = pathArgs(args, new Set(["--color", "-I"]));
    if (!paths) return ask("ls arguments require confirmation");
    return validatePaths(paths, validator) ? allow() : ask("ls path arguments must stay inside workspace");
  }

  if (["cat", "head", "tail"].includes(name)) {
    if (name === "tail" && args.some((arg) => arg.value === "-f" || arg.value === "--follow")) {
      return ask("tail follow mode can block indefinitely");
    }
    const paths = pathArgs(args, new Set(["-n", "-c", "--lines", "--bytes"]));
    if (!paths || paths.length === 0) return ask(`${name} without a file may wait for stdin`);
    return validatePaths(paths, validator) ? allow() : ask(`${name} path arguments must stay inside workspace`);
  }

  if (name === "grep" || name === "rg") {
    const optionValues = new Set(["-e", "-f", "--regexp", "--file", "--glob", "-g"]);
    const positional = pathArgs(args, optionValues);
    if (!positional || positional.length < 2) return ask(`${name} requires explicit path arguments`);
    const paths = positional.slice(1);
    return validatePaths(paths, validator) ? allow() : ask(`${name} path arguments must stay inside workspace`);
  }

  if (name === "git") return classifyGit(args);
  if (name === "bun") return classifyBun(args);

  return ask(`Unknown or mutating command requires confirmation: ${name}`);
}

function classifyGit(args: Token[]): PermissionDecision {
  const subcommand = args[0]?.value;
  if (!subcommand) return ask("git without subcommand requires confirmation");
  if (!["status", "diff", "log"].includes(subcommand)) return ask("Only git status, diff, and log are auto-allowed");
  if (args.slice(1).some((arg) => !arg.value.startsWith("-"))) return ask("git path/revision arguments require confirmation");
  return allow();
}

function classifyBun(args: Token[]): PermissionDecision {
  if (args.length === 2 && args[0]?.value === "run" && args[1]?.value === "typecheck") return allow();
  return ask("Only bun run typecheck is auto-allowed");
}

export function classifyCommand(command: string, options: ClassifyCommandOptions): PermissionDecision {
  const trimmed = command.trim();
  if (trimmed.length === 0) return ask("Empty command requires confirmation");
  if (hasDangerousRawToken(trimmed)) return deny("Command text contains a dangerous token");

  const scanned = scanCommand(trimmed);
  if (!scanned) return ASK;
  if (scanned.hasBackgroundOperator) return deny("Background execution with & is not supported");

  const validator = validateCwd(options);
  if (!validator) return ask("Command cwd must resolve inside workspace");

  const substitutionDecisions = scanned.substitutionCommands.map((subcommand) => classifyCommand(subcommand, options));
  const segmentDecisions: PermissionDecision[] = [];

  for (let i = 0; i < scanned.segments.length; i += 1) {
    const segment = scanned.segments[i]!;
    if (segment.tokens.length === 0) return ask("Empty command segment requires confirmation");
    const dangerous = classifyDangerousSegment(segment, scanned.segments[i + 1]);
    if (dangerous) segmentDecisions.push(dangerous);
  }

  if (scanned.hasUntrustedSyntax || scanned.substitutionCommands.length > 0) {
    const substitutionDecision = combinePermissionDecisions(substitutionDecisions);
    if (substitutionDecision.outcome === "deny") return substitutionDecision;
    return ask("Substitution, subshell, or redirection syntax requires confirmation");
  }

  for (const segment of scanned.segments) {
    if (segmentHasWriteRedirection(segment)) segmentDecisions.push(ask("Write redirection requires confirmation"));
    segmentDecisions.push(classifyReadOnlySegment(segment, validator));
  }

  return combinePermissionDecisions(segmentDecisions);
}


