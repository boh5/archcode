import path from "node:path";
import type {
  NormalizedShellInvocation,
  NormalizedShellRequest,
  ShellPathReference,
  ShellRedirection,
  ShellUncertainty,
} from "../../permission/policy-types";

export interface ParseShellRequestOptions {
  workspaceRoot: string;
  cwd?: string;
}

export interface ShellParseFailure {
  ok: false;
  raw: string;
  cwd: string;
  display: string;
  uncertainty: ShellUncertainty[];
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
  uncertainty: ShellUncertainty[];
  hasBackgroundOperator: boolean;
}

const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh"]);
const TRANSPARENT_WRAPPERS = new Set(["env", "timeout", "time", "nice", "nohup"]);
const CONSERVATIVE_WRAPPERS = new Set(["xargs", "npx", "bunx"]);
const EVAL_TOKENS = new Set(["eval", "source", "."]);
const REDIRECTION_OPERATORS = new Set(["<", ">", ">>", "2>", "2>>", "&>", "&>>"]);

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function uncertainty(kind: ShellUncertainty["kind"], reason: string, token?: string): ShellUncertainty {
  return token === undefined ? { kind, reason } : { kind, reason, token };
}

function normalizeCommandName(value: string): string {
  return path.basename(value);
}

function displayTokens(tokens: Token[]): string {
  return tokens.map((token) => token.value).join(" ");
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

function scanCommand(command: string): ScanResult {
  const segments: Segment[] = [{ tokens: [] }];
  const uncertainties: ShellUncertainty[] = [];
  let token = "";
  let tokenQuoted = false;
  let quote: "single" | "double" | undefined;
  let escaped = false;
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
      if (ch === "`") uncertainties.push(uncertainty("substitution", "Backtick command substitution requires confirmation", "`"));
      if (ch === "$" && command[i + 1] === "(") uncertainties.push(uncertainty("substitution", "Command substitution requires confirmation", "$(...)"));
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
      uncertainties.push(uncertainty("substitution", "Backtick command substitution requires confirmation", "`"));
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      uncertainties.push(uncertainty("substitution", "Command substitution requires confirmation", "$(...)"));
      const extracted = extractSubstitution(command, i + 2);
      if (extracted) i = extracted.endIndex;
      else uncertainties.push(uncertainty("parse", "Unclosed command substitution", "$("));
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      uncertainties.push(uncertainty("parse", "Heredoc syntax requires confirmation", "<<"));
      token += "<<";
      i += 1;
      continue;
    }
    if ((ch === "<" || ch === ">") && command[i + 1] === "(") {
      uncertainties.push(uncertainty("expansion", "Process substitution requires confirmation", `${ch}(`));
      token += ch;
      continue;
    }
    if (ch === "(" || ch === ")") {
      uncertainties.push(uncertainty("parse", "Subshell or grouping syntax requires confirmation", ch));
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
      if (command[i + 1] === ">") {
        token += "&>";
        i += 1;
        if (command[i + 1] === ">") {
          token += ">";
          i += 1;
        }
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
    if (ch === "2" && command[i + 1] === ">") {
      token += "2>";
      i += 1;
      if (command[i + 1] === ">") {
        token += ">";
        i += 1;
      }
      continue;
    }
    if (ch === ">") {
      token += ">";
      if (command[i + 1] === ">") {
        token += ">";
        i += 1;
      }
      continue;
    }
    if (ch === "<") {
      token += "<";
      continue;
    }
    token += ch;
  }

  if (escaped) uncertainties.push(uncertainty("parse", "Trailing escape requires confirmation", "\\"));
  if (quote) uncertainties.push(uncertainty("parse", "Unclosed quote requires confirmation"));
  pushToken();
  return { segments, uncertainty: uncertainties, hasBackgroundOperator };
}

function isRedirectionToken(value: string): boolean {
  return REDIRECTION_OPERATORS.has(value) || /^(?:\d?>{1,2}|&>{1,2}|<)(.+)/.test(value);
}

function splitAttachedRedirection(value: string): { operator: string; target: string } | undefined {
  const match = /^(2>>|2>|&>>|&>|>>|>|<)(.+)$/.exec(value);
  if (!match) return undefined;
  return { operator: match[1]!, target: match[2]! };
}

function redirectionFrom(operator: string, target: string): ShellRedirection {
  if (operator === "<") return { kind: "stdin", operation: "read", target };
  if (operator === "2>" || operator === "2>>") return { kind: "stderr", operation: operator.endsWith(">>") ? "append" : "write", target, fd: 2 };
  if (operator === "&>" || operator === "&>>") return { kind: "stdout-stderr", operation: operator.endsWith(">>") ? "append" : "write", target };
  return { kind: "stdout", operation: operator === ">>" ? "append" : "write", target, fd: 1 };
}

function redirectionPathOperation(redirection: ShellRedirection): ShellPathReference["operation"] {
  return redirection.operation === "read" ? "read" : "write";
}

function parseRedirections(tokens: Token[]): { argvTokens: Token[]; redirections: ShellRedirection[]; uncertainty: ShellUncertainty[] } {
  const argvTokens: Token[] = [];
  const redirections: ShellRedirection[] = [];
  const uncertainties: ShellUncertainty[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (REDIRECTION_OPERATORS.has(token.value)) {
      const target = tokens[i + 1];
      if (!target) {
        uncertainties.push(uncertainty("parse", "Redirection without target requires confirmation", token.value));
        continue;
      }
      redirections.push(redirectionFrom(token.value, target.value));
      i += 1;
      continue;
    }
    const attached = splitAttachedRedirection(token.value);
    if (attached) {
      redirections.push(redirectionFrom(attached.operator, attached.target));
      continue;
    }
    if (isRedirectionToken(token.value)) {
      uncertainties.push(uncertainty("parse", "Unsupported redirection requires confirmation", token.value));
      continue;
    }
    argvTokens.push(token);
  }

  return { argvTokens, redirections, uncertainty: uncertainties };
}

function optionHasValue(option: string, optionsWithValues: ReadonlySet<string>): boolean {
  return optionsWithValues.has(option) || [...optionsWithValues].some((known) => option.startsWith(`${known}=`));
}

function positionalArgs(tokens: Token[], optionsWithValues = new Set<string>()): Token[] {
  const paths: Token[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.value.startsWith("-")) {
      if (optionHasValue(token.value, optionsWithValues) && !token.value.includes("=")) i += 1;
      continue;
    }
    paths.push(token);
  }
  return paths;
}

function appendPath(paths: ShellPathReference[], token: Token | undefined, operation: ShellPathReference["operation"], source: ShellPathReference["source"]): void {
  if (!token || token.quoted || token.value.length === 0) return;
  paths.push({ path: token.value, operation, source });
}

function derivePaths(command: string, args: Token[], redirections: ShellRedirection[]): ShellPathReference[] {
  const paths: ShellPathReference[] = [];
  for (const redirection of redirections) {
    paths.push({ path: redirection.target, operation: redirectionPathOperation(redirection), source: "redirection" });
  }

  if (["cat", "head", "tail", "ls"].includes(command)) {
    const optionValues = command === "ls" ? new Set(["--color", "-I"]) : new Set(["-n", "-c", "--lines", "--bytes"]);
    for (const token of positionalArgs(args, optionValues)) appendPath(paths, token, "read", "argument");
  }
  if (command === "grep" || command === "rg") {
    const positional = positionalArgs(args, new Set(["-e", "-f", "--regexp", "--file", "--glob", "-g"]));
    for (const token of positional.slice(1)) appendPath(paths, token, "read", "argument");
  }
  if (command === "rm") for (const token of positionalArgs(args)) appendPath(paths, token, "delete", "argument");
  if (command === "mv") {
    const positional = positionalArgs(args);
    for (const token of positional.slice(0, -1)) appendPath(paths, token, "delete", "argument");
    appendPath(paths, positional.at(-1), "write", "argument");
  }
  if (command === "cp") for (const token of positionalArgs(args)) appendPath(paths, token, "unknown", "argument");
  if (command === "tee") for (const token of positionalArgs(args, new Set(["-a"]))) appendPath(paths, token, "write", "argument");
  if (command === "curl") {
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      if (arg.value === "-o" || arg.value === "--output") appendPath(paths, args[i + 1], "write", "argument");
      if (arg.value.startsWith("--output=")) paths.push({ path: arg.value.slice("--output=".length), operation: "write", source: "argument" });
    }
  }
  if (command === "wget") {
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      if (arg.value === "-O" || arg.value === "--output-document") appendPath(paths, args[i + 1], "write", "argument");
      if (arg.value.startsWith("--output-document=")) paths.push({ path: arg.value.slice("--output-document=".length), operation: "write", source: "argument" });
    }
  }
  if (command === "git") {
    for (let i = 0; i < args.length; i += 1) if (args[i]!.value === "-C") appendPath(paths, args[i + 1], "read", "argument");
  }

  return paths;
}

function wrapperUncertainty(command: string, argv: string[]): ShellUncertainty[] {
  if (SHELL_WRAPPERS.has(command) && argv.includes("-c")) return [uncertainty("parse", "Shell -c wrapper requires recursive review", `${command} -c`)];
  if (TRANSPARENT_WRAPPERS.has(command)) return [uncertainty("parse", "Wrapper command requires conservative review", command)];
  if (CONSERVATIVE_WRAPPERS.has(command)) return [uncertainty("parse", "Command wrapper may execute dynamic code", command)];
  if (EVAL_TOKENS.has(command)) return [uncertainty("parse", "Shell eval/source requires confirmation", command)];
  if (command.includes("$") || command.includes("`")) return [uncertainty("parse", "Dynamic command name requires confirmation", command)];
  return [];
}

function toInvocation(segment: Segment, segmentIndex: number, cwd: string): NormalizedShellInvocation {
  const parsed = parseRedirections(segment.tokens);
  const commandToken = parsed.argvTokens[0];
  const command = commandToken ? normalizeCommandName(commandToken.value) : "";
  const argv = parsed.argvTokens.map((token) => token.value);
  const uncertaintyList = [...parsed.uncertainty, ...wrapperUncertainty(command, argv)];
  const paths = derivePaths(command, parsed.argvTokens.slice(1), parsed.redirections);
  if (!command) uncertaintyList.push(uncertainty("parse", "Empty command segment requires confirmation"));

  return {
    command,
    argv,
    cwd,
    segmentIndex,
    separatorBefore: segment.separatorBefore,
    redirections: parsed.redirections,
    paths,
    effects: [],
    uncertainty: uncertaintyList,
    display: displayTokens(segment.tokens),
  };
}

export function parseShellRequest(command: string, options: ParseShellRequestOptions): NormalizedShellRequest | ShellParseFailure {
  const raw = command;
  const display = command.trim();
  const cwd = path.resolve(options.workspaceRoot, options.cwd ?? ".");
  if (display.length === 0) {
    return { ok: false, raw, cwd, display, uncertainty: [uncertainty("parse", "Empty command requires confirmation")] };
  }

  const scanned = scanCommand(display);
  const invocations = scanned.segments.map((segment, index) => toInvocation(segment, index, cwd));
  const requestUncertainty = [
    ...scanned.uncertainty,
    ...(scanned.hasBackgroundOperator ? [uncertainty("parse", "Background execution with & is not supported", "&")] : []),
    ...invocations.flatMap((invocation) => invocation.uncertainty),
  ];

  return {
    raw,
    cwd,
    invocations,
    effects: [],
    uncertainty: requestUncertainty,
    display,
  };
}
