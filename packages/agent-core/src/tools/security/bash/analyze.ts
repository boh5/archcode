import { lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type BashAccessOperation = "read" | "write" | "delete" | "execute";

export interface BashAccess {
  operation: BashAccessOperation;
  path: string;
}

export type GitPathspecMode = "default" | "literal" | "noglob";

export type BashSeparator = "&&" | "||" | ";" | "|";

export interface BashInvocation {
  command: string;
  argv: string[];
  quoted: boolean[];
  literal: boolean[];
  escaped: boolean[];
  unquotedPattern: boolean[];
  cwd: string;
  segmentIndex: number;
  separatorBefore?: BashSeparator;
  accesses: BashAccess[];
  dynamic: boolean;
  privilege: boolean;
  privilegeShapeSupported: boolean;
  shellWrapper?: string;
  remoteDestination?: boolean;
  recursive?: boolean;
  gitGlobalShapeSupported?: boolean;
  gitSubcommandIndex?: number;
  gitPathspecMode?: GitPathspecMode;
  targetOperation?: BashAccessOperation;
  targetArgvIndexes?: number[];
}

export interface BashAnalysis {
  command: string;
  cwd: string;
  invocations: BashInvocation[];
  accesses: BashAccess[];
  hasBackgroundOperator: boolean;
  hasDynamicReferences: boolean;
}

export interface AnalyzeBashOptions {
  workspaceRoot: string;
  cwd?: string;
}

interface Token {
  value: string;
  literal: boolean;
  quoted: boolean;
  escaped: boolean;
  leadingTilde: boolean;
  assignmentValueLeadingTilde?: boolean;
  unquotedPattern: boolean;
}

interface Segment {
  tokens: Token[];
  separatorBefore?: BashSeparator;
}

const AMBIGUOUS_OUTPUT_REDIRECT = "__ambiguous_output_redirect__";
const REDIRECTS = new Set(["<", ">", ">>", ">|", "<>", "2>", "2>>", "&>", "&>>", "<<", "<<-", "<<<", AMBIGUOUS_OUTPUT_REDIRECT]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const PRIVILEGE = new Set(["sudo", "doas", "pkexec", "runuser", "su", "machinectl"]);
const INTERPRETERS = new Set(["python", "python3", "node", "ruby", "perl", "bun", "deno"]);
const FIXED_VARIABLE = /^(?:\$HOME|\$\{HOME\}|\$PWD|\$\{PWD\})(?:\/.*)?$/;
const DYNAMIC_PATTERN = /\$\(|`|\$\{|\$[A-Za-z_]|[?*\[]/;

interface HeredocDelimiter {
  value: string;
  stripTabs: boolean;
}

function decodeAnsiCEscape(input: string, start: number): { value: string; end: number } {
  const escaped = input[start + 1];
  if (escaped === undefined) return { value: "\\", end: start + 1 };
  const simple: Readonly<Record<string, string>> = {
    a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
    "\\": "\\", "'": "'", '"': '"', "?": "?",
  };
  if (simple[escaped] !== undefined) return { value: simple[escaped], end: start + 2 };
  if (/[0-7]/.test(escaped)) {
    const digits = input.slice(start + 1).match(/^[0-7]{1,3}/)![0];
    return { value: String.fromCodePoint(Number.parseInt(digits, 8)), end: start + 1 + digits.length };
  }
  if (escaped === "x") {
    const digits = input.slice(start + 2).match(/^[0-9A-Fa-f]{1,2}/)?.[0];
    return digits
      ? { value: String.fromCodePoint(Number.parseInt(digits, 16)), end: start + 2 + digits.length }
      : { value: "\\x", end: start + 2 };
  }
  if (escaped === "u" || escaped === "U") {
    const limit = escaped === "u" ? 4 : 8;
    const digits = input.slice(start + 2).match(new RegExp(`^[0-9A-Fa-f]{1,${limit}}`))?.[0];
    const codePoint = digits ? Number.parseInt(digits, 16) : Number.NaN;
    return digits && codePoint <= 0x10ffff
      ? { value: String.fromCodePoint(codePoint), end: start + 2 + digits.length }
      : { value: `\\${escaped}`, end: start + 2 };
  }
  if (escaped === "c" && input[start + 2] !== undefined) {
    return { value: String.fromCodePoint(input.charCodeAt(start + 2) & 0x1f), end: start + 3 };
  }
  return { value: `\\${escaped}`, end: start + 2 };
}

function decodeAnsiCQuoted(input: string, start: number): { value: string; end: number; closed: boolean } {
  let value = "";
  let index = start;
  let nul = false;
  while (index < input.length) {
    const ch = input[index]!;
    if (ch === "'") return { value, end: index + 1, closed: true };
    if (ch === "\\") {
      const decoded = decodeAnsiCEscape(input, index);
      const nulIndex = decoded.value.indexOf("\0");
      if (!nul) value += nulIndex < 0 ? decoded.value : decoded.value.slice(0, nulIndex);
      if (nulIndex >= 0) nul = true;
      index = decoded.end;
      continue;
    }
    if (!nul) value += ch;
    index += 1;
  }
  return { value, end: index, closed: false };
}

function removeHeredocDelimiterQuotes(word: string): string | undefined {
  let delimiter = "";
  let index = 0;
  while (index < word.length) {
    const ch = word[index]!;
    if (ch === "\\") {
      if (index + 1 >= word.length) return undefined;
      delimiter += word[index + 1]!;
      index += 2;
      continue;
    }
    if (ch !== "'" && ch !== '"' && !(ch === "$" && (word[index + 1] === "'" || word[index + 1] === '"'))) {
      delimiter += ch;
      index += 1;
      continue;
    }

    const special = ch === "$";
    const quote = special ? word[index + 1]! : ch;
    const ansiC = special && quote === "'";
    index += special ? 2 : 1;
    if (ansiC) {
      const decoded = decodeAnsiCQuoted(word, index);
      if (!decoded.closed) return undefined;
      delimiter += decoded.value;
      index = decoded.end;
      continue;
    }
    let closed = false;
    while (index < word.length) {
      const quoted = word[index]!;
      if (quoted === quote) {
        closed = true;
        index += 1;
        break;
      }
      if (quote === '"' && quoted === "\\" && index + 1 < word.length) {
        const escaped = word[index + 1]!;
        if (["$", "`", '"', "\\"].includes(escaped)) {
          delimiter += escaped;
          index += 2;
          continue;
        }
      }
      delimiter += quoted;
      index += 1;
    }
    if (!closed) return undefined;
  }
  return delimiter;
}

function heredocDelimiterWordEnd(line: string, start: number): number | undefined {
  let index = start;
  while (index < line.length) {
    const ch = line[index]!;
    if (/\s/.test(ch) || /[;&|()<>]/.test(ch)) break;
    if (ch === "\\") {
      if (index + 1 >= line.length) return undefined;
      index += 2;
      continue;
    }
    if (ch === "$" && (line[index + 1] === "(" || line[index + 1] === "{")) {
      const open = line[index + 1] as "(" | "{";
      const close = open === "(" ? ")" : "}";
      const end = balancedExpansionEnd(line, index + 1, open, close);
      if (line[end] !== close) return undefined;
      index = end + 1;
      continue;
    }
    if (ch === "`") {
      const end = backtickExpansionEnd(line, index);
      if (line[end] !== "`") return undefined;
      index = end + 1;
      continue;
    }
    if (ch === "$" && line[index + 1] === "'") {
      const decoded = decodeAnsiCQuoted(line, index + 2);
      if (!decoded.closed) return undefined;
      index = decoded.end;
      continue;
    }
    if (ch === "'" || ch === '"' || (ch === "$" && (line[index + 1] === "'" || line[index + 1] === '"'))) {
      const special = ch === "$";
      const quote = special ? line[index + 1]! : ch;
      index += special ? 2 : 1;
      let closed = false;
      while (index < line.length) {
        const quoted = line[index]!;
        if (quoted === quote) {
          closed = true;
          index += 1;
          break;
        }
        if (quote === '"' && quoted === "\\" && index + 1 < line.length) {
          index += 2;
          continue;
        }
        index += 1;
      }
      if (!closed) return undefined;
      continue;
    }
    index += 1;
  }
  return index;
}

function parseHeredocDelimiter(line: string, start: number): { delimiter: string; end: number } | undefined {
  let wordStart = start;
  while (line[wordStart] === " " || line[wordStart] === "\t") wordStart += 1;
  if (wordStart >= line.length) return undefined;
  const end = heredocDelimiterWordEnd(line, wordStart);
  if (end === undefined || end === wordStart) return undefined;
  const delimiter = removeHeredocDelimiterQuotes(line.slice(wordStart, end));
  return delimiter === undefined ? undefined : { delimiter, end };
}

function removeUnquotedLineContinuations(command: string): string {
  let result = "";
  let quote: "single" | "double" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index]!;
    if (ch === "\\" && command[index + 1] === "\n" && quote !== "single") {
      index += 1;
      continue;
    }
    result += ch;
    if (quote === "single") {
      if (ch === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      if (ch === '"') quote = undefined;
      else if (ch === "\\" && index + 1 < command.length) result += command[++index]!;
      continue;
    }
    if (ch === "'") quote = "single";
    else if (ch === '"') quote = "double";
    else if (ch === "\\" && index + 1 < command.length) result += command[++index]!;
  }
  return result;
}

function maskOpaqueShellSyntax(command: string): { masked: string; unterminated: boolean } {
  const chars = [...command];
  let unterminated = false;
  const blank = (start: number, end: number) => {
    for (let index = start; index <= end; index += 1) if (chars[index] !== "\n") chars[index] = "_";
  };

  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index]!;
    if (ch === "\\") {
      blank(index, Math.min(index + 1, command.length - 1));
      if (command[index + 1] !== "\n") chars[index] = "_";
      index += 1;
      continue;
    }
    if (ch === "$" && command[index + 1] === "'") {
      const decoded = decodeAnsiCQuoted(command, index + 2);
      const end = decoded.closed ? decoded.end - 1 : command.length - 1;
      if (!decoded.closed) unterminated = true;
      blank(index, end);
      index = end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let end = index + 1;
      let closed = false;
      for (; end < command.length; end += 1) {
        if (quote === '"' && command[end] === "\\") {
          end += 1;
          continue;
        }
        if (command[end] === quote) {
          closed = true;
          break;
        }
      }
      if (!closed) {
        end = command.length - 1;
        unterminated = true;
      }
      blank(index, end);
      chars[index] = "_";
      index = end;
      continue;
    }
    if (ch === "$" && command[index + 1] === "(") {
      const end = balancedExpansionEnd(command, index + 1, "(", ")");
      blank(index, end);
      chars[index] = "_";
      if (command[end] !== ")") unterminated = true;
      index = end;
      continue;
    }
    if (ch === "$" && command[index + 1] === "{") {
      const end = balancedExpansionEnd(command, index + 1, "{", "}");
      blank(index, end);
      chars[index] = "_";
      if (command[end] !== "}") unterminated = true;
      index = end;
      continue;
    }
    if ((ch === "<" || ch === ">") && command[index + 1] === "(") {
      const end = balancedExpansionEnd(command, index + 1, "(", ")");
      blank(index, end);
      chars[index] = "_";
      if (command[end] !== ")") unterminated = true;
      index = end;
      continue;
    }
    if (ch === "`") {
      const end = backtickExpansionEnd(command, index);
      blank(index, end);
      chars[index] = "_";
      if (end === index || command[end] !== "`") unterminated = true;
      index = end;
    }
  }
  return { masked: chars.join(""), unterminated };
}

function uncommentedShellCode(maskedLine: string): string {
  let atWordStart = true;
  for (let index = 0; index < maskedLine.length; index += 1) {
    const ch = maskedLine[index]!;
    if (ch === " " || ch === "\t") {
      atWordStart = true;
      continue;
    }
    if (ch === "#" && atWordStart) return maskedLine.slice(0, index);
    atWordStart = /[;&|()<>]/.test(ch);
  }
  return maskedLine;
}

function commandBlockIsIncomplete(masked: string, unterminated: boolean): boolean {
  if (unterminated) return true;
  const code = masked.split("\n").map(uncommentedShellCode).join("\n").trimEnd();
  return /(?:&&|\|\||\|&|\|)$/.test(code);
}

function discoverHeredocDelimiters(maskedLine: string, originalLine: string): HeredocDelimiter[] {
  const delimiters: HeredocDelimiter[] = [];
  let atWordStart = true;
  for (let index = 0; index < maskedLine.length; index += 1) {
    const ch = maskedLine[index]!;
    if (ch === " " || ch === "\t") {
      atWordStart = true;
      continue;
    }
    if (ch === "#" && atWordStart) break;
    if (ch === "\\") {
      index += 1;
      atWordStart = false;
      continue;
    }
    if (ch === "$" && maskedLine[index + 1] === "(") {
      index = balancedExpansionEnd(maskedLine, index + 1, "(", ")");
      atWordStart = false;
      continue;
    }
    if (ch === "$" && maskedLine[index + 1] === "{") {
      index = balancedExpansionEnd(maskedLine, index + 1, "{", "}");
      atWordStart = false;
      continue;
    }
    if ((ch === "<" || ch === ">") && maskedLine[index + 1] === "(") {
      index = balancedExpansionEnd(maskedLine, index + 1, "(", ")");
      atWordStart = false;
      continue;
    }
    if (ch === "`") {
      index = backtickExpansionEnd(maskedLine, index);
      atWordStart = false;
      continue;
    }
    if (ch === "<" && maskedLine[index + 1] === "<" && maskedLine[index + 2] !== "<") {
      const stripTabs = originalLine[index + 2] === "-";
      const parsed = parseHeredocDelimiter(originalLine, index + (stripTabs ? 3 : 2));
      if (parsed) {
        delimiters.push({ value: parsed.delimiter, stripTabs });
        index = parsed.end - 1;
        atWordStart = false;
        continue;
      }
    }
    atWordStart = /[;&|()<>]/.test(ch);
  }
  return delimiters;
}

function stripHeredocBodies(command: string): { command: string; dynamic: boolean } {
  const normalized = removeUnquotedLineContinuations(command);
  const kept: string[] = [];
  const pending: HeredocDelimiter[] = [];
  const commandBlock: string[] = [];
  let dynamic = false;
  for (const line of normalized.split("\n")) {
    const active = pending[0];
    if (active) {
      const candidate = active.stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === active.value) pending.shift();
      continue;
    }
    kept.push(line);
    commandBlock.push(line);
    const originalBlock = commandBlock.join("\n");
    const maskedBlock = maskOpaqueShellSyntax(originalBlock);
    if (commandBlockIsIncomplete(maskedBlock.masked, maskedBlock.unterminated)) continue;

    const maskedLines = maskedBlock.masked.split("\n");
    const discovered = commandBlock.flatMap((originalLine, index) => discoverHeredocDelimiters(maskedLines[index]!, originalLine));
    commandBlock.length = 0;
    if (discovered.length > 0) {
      pending.push(...discovered);
      dynamic = true;
    }
  }
  return { command: kept.join("\n"), dynamic };
}

function balancedExpansionEnd(command: string, start: number, open: "(" | "{" | "[", close: ")" | "}" | "]"): number {
  let depth = 0;
  let quote: "single" | "double" | undefined;
  let escaped = false;
  for (let i = start; i < command.length; i += 1) {
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
    if (ch === open) depth += 1;
    else if (ch === close && --depth === 0) return i;
  }
  return command.length - 1;
}

function backtickExpansionEnd(command: string, start: number): number {
  let escaped = false;
  for (let i = start + 1; i < command.length; i += 1) {
    const ch = command[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "`") return i;
  }
  return command.length - 1;
}

function shellWordEnd(command: string, start: number): number {
  let quote: "single" | "double" | undefined;
  let escaped = false;
  for (let index = start; index < command.length; index += 1) {
    const ch = command[index]!;
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
    if (/\s/.test(ch) || /[;&|<>]/.test(ch)) return index;
  }
  return command.length;
}

function scan(rawCommand: string): { segments: Segment[]; background: boolean; dynamic: boolean } {
  const heredoc = stripHeredocBodies(rawCommand);
  const command = heredoc.command;
  const segments: Segment[] = [{ tokens: [] }];
  let value = "";
  let literal = true;
  let quoted = false;
  let tokenEscaped = false;
  let leadingTilde = false;
  let assignmentValueLeadingTilde = false;
  let unquotedPattern = false;
  let quote: "single" | "double" | undefined;
  let escaped = false;
  let background = false;
  let dynamic = heredoc.dynamic;

  const current = () => segments[segments.length - 1]!;
  const pushToken = () => {
    if (value.length > 0 || quoted) current().tokens.push({ value, literal, quoted, escaped: tokenEscaped, leadingTilde, assignmentValueLeadingTilde, unquotedPattern });
    value = "";
    literal = true;
    quoted = false;
    tokenEscaped = false;
    leadingTilde = false;
    assignmentValueLeadingTilde = false;
    unquotedPattern = false;
  };
  const pushSegment = (separatorBefore: BashSeparator) => {
    pushToken();
    segments.push({ tokens: [], separatorBefore });
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (escaped) {
      if (ch === "\n") {
        escaped = false;
        continue;
      }
      value += ch;
      tokenEscaped = true;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote === "double") {
      const next = command[i + 1];
      if (next === "\n") {
        i += 1;
        continue;
      }
      if (next !== undefined && ["$", "`", '"', "\\"].includes(next)) {
        value += next;
        tokenEscaped = true;
        i += 1;
        continue;
      }
      value += "\\";
      continue;
    }
    if (ch === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }
    if (quote === undefined && ch === "$" && command[i + 1] === "'") {
      const decoded = decodeAnsiCQuoted(command, i + 2);
      value += decoded.value;
      quoted = true;
      if (!decoded.closed) dynamic = true;
      i = decoded.end - 1;
      continue;
    }
    if (quote === undefined && ch === "$" && command[i + 1] === '"') {
      quote = "double";
      quoted = true;
      i += 1;
      continue;
    }
    if (quote !== "single" && ch === "$" && command[i + 1] === "(") {
      const end = balancedExpansionEnd(command, i + 1, "(", ")");
      value += command.slice(i, end + 1);
      literal = false;
      dynamic = true;
      i = end;
      continue;
    }
    if (quote !== "single" && ch === "$" && command[i + 1] === "{") {
      const end = balancedExpansionEnd(command, i + 1, "{", "}");
      value += command.slice(i, end + 1);
      literal = false;
      dynamic = true;
      i = end;
      continue;
    }
    if (quote !== "single" && ch === "$" && command[i + 1] === "[") {
      const end = balancedExpansionEnd(command, i + 1, "[", "]");
      value += command.slice(i, end + 1);
      literal = false;
      dynamic = true;
      i = end;
      continue;
    }
    if (quote === undefined && value.length === 0 && ch === "(" && command[i + 1] === "(") {
      const end = balancedExpansionEnd(command, i, "(", ")");
      value += command.slice(i, end + 1);
      literal = false;
      dynamic = true;
      i = end;
      continue;
    }
    if (quote !== "single" && (ch === "<" || ch === ">") && command[i + 1] === "(") {
      const end = balancedExpansionEnd(command, i + 1, "(", ")");
      value += command.slice(i, end + 1);
      literal = false;
      dynamic = true;
      i = end;
      continue;
    }
    if (quote !== "single" && ch === "`") {
      const end = backtickExpansionEnd(command, i);
      value += command.slice(i, end + 1);
      literal = false;
      dynamic = true;
      i = end;
      continue;
    }
    if (quote === "single") {
      if (ch === "'") quote = undefined;
      else value += ch;
      continue;
    }
    if (quote === "double") {
      if (ch === '"') {
        quote = undefined;
      } else {
        value += ch;
        if (ch === "$" || ch === "`") {
          literal = false;
          dynamic = true;
        }
      }
      continue;
    }
    if (ch === "#" && value.length === 0 && !quoted) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i += 1;
      continue;
    }
    if (ch === "'") {
      quote = "single";
      quoted = true;
      continue;
    }
    if (ch === '"') {
      quote = "double";
      quoted = true;
      continue;
    }
    if (ch === "\n") {
      if (value.length > 0 || current().tokens.length > 0) pushSegment(";");
      continue;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    if (value.length === 0) {
      const inputAmpRedirect = /^(?:\d+)?<&/.exec(command.slice(i));
      if (inputAmpRedirect) {
        let targetStart = i + inputAmpRedirect[0].length;
        while (command[targetStart] === " " || command[targetStart] === "\t") targetStart += 1;
        const targetEnd = shellWordEnd(command, targetStart);
        const target = command.slice(targetStart, targetEnd);
        if (!/^(?:\d+|-)$/.test(target)) dynamic = true;
        i = Math.max(targetEnd, i + inputAmpRedirect[0].length) - 1;
        continue;
      }
      const numericAmpRedirect = /^(\d+)>&/.exec(command.slice(i));
      if (numericAmpRedirect) {
        const remainder = command.slice(i + numericAmpRedirect[0].length);
        const fdTarget = /^(?:\d+|-)(?=$|\s|[;&|<>])/.exec(remainder);
        if (fdTarget) {
          i += numericAmpRedirect[0].length + fdTarget[0].length - 1;
        } else {
          current().tokens.push({
            value: numericAmpRedirect[1] === "1" ? ">" : AMBIGUOUS_OUTPUT_REDIRECT,
            literal: true,
            quoted: false,
            escaped: false,
            leadingTilde: false,
            unquotedPattern: false,
          });
          i += numericAmpRedirect[0].length - 1;
        }
        continue;
      }
      const fdDuplication = /^(?:\d+)?[<>]&(?:\d+|-)/.exec(command.slice(i));
      if (fdDuplication) {
        i += fdDuplication[0].length - 1;
        continue;
      }
      const fdPathRedirect = /^\d+(>>|>\||<>|>|<)/.exec(command.slice(i));
      if (fdPathRedirect) {
        current().tokens.push({ value: fdPathRedirect[1]!, literal: true, quoted: false, escaped: false, leadingTilde: false, unquotedPattern: false });
        i += fdPathRedirect[0].length - 1;
        continue;
      }
    }
    if (ch === ")") {
      pushToken();
      continue;
    }
    if (ch === ";" && command[i + 1] === ";" && command[i + 2] === "&") {
      pushToken();
      i += 2;
      continue;
    }
    if (ch === ";" && command[i + 1] === "&") {
      pushToken();
      i += 1;
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      pushSegment("&&");
      i += 1;
      continue;
    }
    if (ch === "&" && command[i + 1] === ">") {
      pushToken();
      current().tokens.push({ value: command[i + 2] === ">" ? "&>>" : "&>", literal: true, quoted: false, escaped: false, leadingTilde: false, unquotedPattern: false });
      i += command[i + 2] === ">" ? 2 : 1;
      continue;
    }
    if (ch === "&") {
      pushToken();
      background = true;
      continue;
    }
    if (ch === "|" && command[i + 1] === "|") {
      pushSegment("||");
      i += 1;
      continue;
    }
    if (ch === "|" && command[i + 1] === "&") {
      pushSegment("|");
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
    if (ch === "2" && command[i + 1] === ">" && command[i + 2] === "&") {
      pushToken();
      i += 2;
      while (/[0-9-]/.test(command[i + 1] ?? "")) i += 1;
      continue;
    }
    if (ch === "2" && command[i + 1] === ">") {
      pushToken();
      current().tokens.push({ value: command[i + 2] === ">" ? "2>>" : "2>", literal: true, quoted: false, escaped: false, leadingTilde: false, unquotedPattern: false });
      i += command[i + 2] === ">" ? 2 : 1;
      continue;
    }
    if (ch === ">" && command[i + 1] === "&") {
      pushToken();
      const fdTarget = /^(?:\d+|-)(?=$|\s|[;&|<>])/.exec(command.slice(i + 2));
      if (fdTarget) {
        i += 1 + fdTarget[0].length;
      } else {
        current().tokens.push({ value: ">", literal: true, quoted: false, escaped: false, leadingTilde: false, unquotedPattern: false });
        i += 1;
      }
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      pushToken();
      if (command[i + 2] === "<") {
        current().tokens.push({ value: "<<<", literal: true, quoted: false, escaped: false, leadingTilde: false, unquotedPattern: false });
        i += 2;
        dynamic = true;
        continue;
      }
      const strip = command[i + 2] === "-";
      current().tokens.push({ value: strip ? "<<-" : "<<", literal: true, quoted: false, escaped: false, leadingTilde: false, unquotedPattern: false });
      i += strip ? 2 : 1;
      dynamic = true;
      continue;
    }
    if (ch === "<" && command[i + 1] === ">") {
      pushToken();
      current().tokens.push({ value: "<>", literal: true, quoted: false, escaped: false, leadingTilde: false, unquotedPattern: false });
      i += 1;
      continue;
    }
    if (ch === ">" && command[i + 1] === "|") {
      pushToken();
      current().tokens.push({ value: ">|", literal: true, quoted: false, escaped: false, leadingTilde: false, unquotedPattern: false });
      i += 1;
      continue;
    }
    if (ch === ">" || ch === "<") {
      pushToken();
      const double = ch === ">" && command[i + 1] === ">";
      current().tokens.push({ value: double ? ">>" : ch, literal: true, quoted: false, escaped: false, leadingTilde: false, unquotedPattern: false });
      if (double) i += 1;
      continue;
    }
    if (value.length === 0 && !quoted && ch === "~") leadingTilde = true;
    if (!quoted && !tokenEscaped && /^[A-Za-z_][A-Za-z0-9_]*=$/.test(value) && ch === "~") assignmentValueLeadingTilde = true;
    value += ch;
    if (ch === "*" || ch === "?" || ch === "[" || ch === "{" || ch === "}") unquotedPattern = true;
    if (ch === "$" || ch === "`" || ch === "(" || ch === ")" || ch === "*" || ch === "?" || ch === "[" || ch === "{" || ch === "}") {
      literal = false;
      dynamic = true;
    }
  }
  if (escaped || quote) dynamic = true;
  pushToken();
  return { segments, background, dynamic };
}

function realpathNearest(input: string, followFinalSymlink: boolean, seen = new Set<string>()): string | undefined {
  const root = path.parse(input).root;
  if (!root) return undefined;
  const components = input.slice(root.length).split(path.sep).filter((component) => component.length > 0);
  let current = root;

  for (let index = 0; index < components.length; index += 1) {
    const component = components[index]!;
    if (component === ".") continue;
    if (component === "..") {
      current = path.dirname(current);
      continue;
    }

    const candidate = path.join(current, component);
    const isFinal = index === components.length - 1;
    try {
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink() && (followFinalSymlink || !isFinal)) {
        if (seen.has(candidate)) return undefined;
        seen.add(candidate);
        const target = readlinkSync(candidate);
        const targetInput = path.isAbsolute(target)
          ? target
          : `${path.dirname(candidate)}${path.sep}${target}`;
        const remainder = components.slice(index + 1).join(path.sep);
        return realpathNearest(
          remainder.length > 0 ? `${targetInput}${path.sep}${remainder}` : targetInput,
          followFinalSymlink,
          seen,
        );
      }
      if (!stat.isSymbolicLink()) current = realpathSync.native(candidate);
      else {
        const actualEntry = readdirSync(current).find((entry) => {
          if (entry === component) return true;
          try {
            const entryStat = lstatSync(path.join(current, entry));
            return entryStat.dev === stat.dev && entryStat.ino === stat.ino;
          } catch {
            return false;
          }
        });
        current = path.join(current, actualEntry ?? component);
      }
      continue;
    } catch {}
    current = candidate;
  }
  return current;
}

function expandFixedPath(value: string, cwd: string): string | undefined {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return `${homedir()}${path.sep}${value.slice(2)}`;
  if (value === "$HOME" || value === "${HOME}") return homedir();
  if (value.startsWith("$HOME/") || value.startsWith("${HOME}/")) return `${homedir()}${path.sep}${value.slice(value.indexOf("/") + 1)}`;
  if (value === "$PWD" || value === "${PWD}") return cwd;
  if (value.startsWith("$PWD/") || value.startsWith("${PWD}/")) return `${cwd}${path.sep}${value.slice(value.indexOf("/") + 1)}`;
  return undefined;
}

function literalPath(token: Token | undefined, cwd: string, followFinalSymlink: boolean): string | undefined {
  if (!token || token.value.length === 0) return undefined;
  if (token.unquotedPattern) return undefined;
  const tildeExpansion = token.leadingTilde && (token.value === "~" || token.value.startsWith("~/"));
  const fixedVariableExpansion = !token.literal && FIXED_VARIABLE.test(token.value);
  const fixed = tildeExpansion || fixedVariableExpansion ? expandFixedPath(token.value, cwd) : undefined;
  if (!token.literal && fixed === undefined) return undefined;
  if (!token.quoted && !token.escaped && DYNAMIC_PATTERN.test(token.value) && fixed === undefined) return undefined;
  const input = fixed ?? (path.isAbsolute(token.value) ? token.value : `${cwd}${path.sep}${token.value}`);
  return realpathNearest(input, followFinalSymlink);
}

const cwdDependentAccesses = new WeakSet<BashAccess>();

function pushAccess(accesses: BashAccess[], access: BashAccess, cwdDependent: boolean): void {
  if (cwdDependent) cwdDependentAccesses.add(access);
  accesses.push(access);
}

function tokenPathDependsOnCwd(token: Token): boolean {
  const homeFixed = token.leadingTilde || token.value === "$HOME" || token.value === "${HOME}"
    || token.value.startsWith("$HOME/") || token.value.startsWith("${HOME}/");
  return !homeFixed && !path.isAbsolute(token.value);
}

function add(accesses: BashAccess[], token: Token | undefined, operation: BashAccessOperation, cwd: string, followFinalSymlink = operation === "read" || operation === "execute"): void {
  const resolved = literalPath(token, cwd, followFinalSymlink);
  if (resolved && token) pushAccess(accesses, { operation, path: resolved }, tokenPathDependsOnCwd(token));
}

function forcesDirectoryTraversal(value: string): boolean {
  const components = value.split("/").filter((component) => component.length > 0);
  return value.endsWith("/") || components.at(-1) === ".";
}

function rmDeleteToken(token: Token): Token {
  const stripped = token.value.replace(/(?:\/\.)+\/?$/, "");
  return stripped === token.value ? token : { ...token, value: stripped || "/" };
}

interface PositionalContract {
  valueOptions?: ReadonlySet<string>;
  optionalValueOptions?: ReadonlySet<string>;
  flagOptions?: ReadonlySet<string>;
  shortFlags?: string;
  shortValueFlags?: string;
  shortOptionalValueFlags?: string;
  firstDashPositionalPattern?: RegExp;
}

interface DescriptorState {
  supported: boolean;
}

interface ParsedOptionValue {
  option: string;
  value: Token;
}

interface ParsedOptions {
  positionals: Token[];
  positionalIndexes: number[];
  optionValues: ParsedOptionValue[];
  flags: Set<string>;
  supported: boolean;
}

function parseOptions(args: Token[], contract: PositionalContract = {}, state?: DescriptorState): ParsedOptions {
  const positionals: Token[] = [];
  const positionalIndexes: number[] = [];
  const optionValues: ParsedOptionValue[] = [];
  const flags = new Set<string>();
  const unsupported = (): ParsedOptions => {
    if (state) state.supported = false;
    return { positionals: [], positionalIndexes: [], optionValues: [], flags: new Set(), supported: false };
  };
  let options = true;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (options && token.value === "--") {
      options = false;
      continue;
    }
    if (options && token.value.startsWith("--")) {
      const equals = token.value.indexOf("=");
      const name = equals < 0 ? token.value : token.value.slice(0, equals);
      if (contract.valueOptions?.has(name)) {
        if ((equals < 0 && args[i + 1] === undefined) || equals === token.value.length - 1) return unsupported();
        const value = equals < 0 ? args[++i]! : { ...token, value: token.value.slice(equals + 1) };
        optionValues.push({ option: name, value });
        continue;
      }
      if (contract.optionalValueOptions?.has(name)) {
        if (equals >= 0) optionValues.push({ option: name, value: { ...token, value: token.value.slice(equals + 1) } });
        else flags.add(name);
        continue;
      }
      if (equals < 0 && contract.flagOptions?.has(name)) {
        flags.add(name);
        continue;
      }
      return unsupported();
    }
    if (options && token.value.startsWith("-") && token.value !== "-") {
      const body = token.value.slice(1);
      for (let offset = 0; offset < body.length; offset += 1) {
        const flag = body[offset]!;
        const option = `-${flag}`;
        if (contract.shortFlags?.includes(flag)) {
          flags.add(option);
          continue;
        }
        if (contract.shortValueFlags?.includes(flag)) {
          let value: Token;
          if (offset === body.length - 1) {
            if (args[i + 1] === undefined) return unsupported();
            value = args[++i]!;
          } else value = { ...token, value: body.slice(offset + 1) };
          optionValues.push({ option, value });
          offset = body.length;
          continue;
        }
        if (contract.shortOptionalValueFlags?.includes(flag)) {
          if (offset < body.length - 1) optionValues.push({ option, value: { ...token, value: body.slice(offset + 1) } });
          else flags.add(option);
          offset = body.length;
          continue;
        }
        if (positionals.length === 0 && contract.firstDashPositionalPattern?.test(token.value)) {
          positionals.push(token);
          positionalIndexes.push(i);
          options = false;
          break;
        }
        return unsupported();
      }
      if (!options) continue;
      continue;
    }
    positionals.push(token);
    positionalIndexes.push(i);
  }
  return { positionals, positionalIndexes, optionValues, flags, supported: true };
}

function positionals(args: Token[], contract: PositionalContract = {}, state?: DescriptorState): Token[] {
  return parseOptions(args, contract, state).positionals;
}

function sourceScript(args: Token[], state: DescriptorState): Token | undefined {
  if (args[0]?.value === "--") return args[1];
  if (args[0]?.value.startsWith("-") && args[0]?.value !== "-") {
    state.supported = false;
    return undefined;
  }
  return args[0];
}

function destinationAccesses(command: "cp" | "install" | "mv" | "ln", args: Token[], cwd: string, state: DescriptorState): BashAccess[] {
  const contract: PositionalContract = command === "cp"
    ? {
        valueOptions: new Set(["--target-directory", "--suffix", "--context"]),
        optionalValueOptions: new Set(["--backup", "--reflink", "--sparse"]),
        flagOptions: new Set(["--archive", "--copy-contents", "--dereference", "--force", "--interactive", "--link", "--no-clobber", "--no-dereference", "--no-target-directory", "--parents", "--preserve", "--recursive", "--remove-destination", "--symbolic-link", "--update", "--verbose"]),
        shortFlags: "abdfHiLlNnPpRrsTuvxZ",
        shortValueFlags: "tS",
      }
    : command === "install"
      ? {
          valueOptions: new Set(["--target-directory", "--mode", "--owner", "--group", "--suffix", "--context"]),
          optionalValueOptions: new Set(["--backup"]),
          flagOptions: new Set(["--compare", "--directory", "--create-leading", "--no-target-directory", "--preserve-timestamps", "--strip", "--verbose"]),
          shortFlags: "bCcDdpsTvZ",
          shortValueFlags: "tmogS",
        }
      : command === "mv"
        ? {
            valueOptions: new Set(["--target-directory", "--suffix", "--context"]),
            optionalValueOptions: new Set(["--backup"]),
            flagOptions: new Set(["--force", "--interactive", "--no-clobber", "--no-target-directory", "--update", "--verbose"]),
            shortFlags: "bfinTuvZ",
            shortValueFlags: "tS",
          }
        : {
            valueOptions: new Set(["--target-directory", "--suffix"]),
            optionalValueOptions: new Set(["--backup"]),
            flagOptions: new Set(["--directory", "--logical", "--physical", "--recursive", "--relative", "--symbolic", "--no-dereference", "--no-target-directory", "--verbose"]),
            shortFlags: "bdFfiLnPrsTv",
            shortValueFlags: "tS",
          };
  const parsed = parseOptions(args, contract, state);
  if (!parsed.supported) return [];
  const values = parsed.positionals;
  const explicitTarget = parsed.optionValues.find(({ option }) => option === "-t" || option === "--target-directory")?.value;
  const directoryMode = command === "install" && (parsed.flags.has("-d") || parsed.flags.has("--directory"));
  if (directoryMode) {
    const accesses: BashAccess[] = [];
    for (const directory of values) add(accesses, directory, "write", cwd, false);
    return accesses;
  }
  if (values.length < (explicitTarget ? 1 : 2)) return [];
  const sourceTokens = explicitTarget ? values : values.slice(0, -1);
  const destinationToken = explicitTarget ?? values.at(-1)!;
  const noTargetDirectory = parsed.flags.has("-T") || parsed.flags.has("--no-target-directory");
  const symbolic = command === "ln" && (parsed.flags.has("-s") || parsed.flags.has("--symbolic"));
  const accesses: BashAccess[] = [];
  if (!symbolic) for (const source of sourceTokens) add(accesses, source, command === "mv" ? "delete" : "read", cwd, command !== "mv");

  const destinationEntry = literalPath(destinationToken, cwd, false);
  if (!destinationEntry) return accesses;
  let destinationDirectory: string | undefined;
  if (!noTargetDirectory) {
    try {
      const followedDestination = literalPath(destinationToken, cwd, true);
      if (followedDestination && statSync(followedDestination).isDirectory()) destinationDirectory = followedDestination;
    } catch {}
  }
  if (destinationDirectory) {
    for (const source of sourceTokens) {
      const sourceName = literalBasename(source, cwd);
      if (sourceName) pushAccess(accesses, { operation: "write", path: path.join(destinationDirectory, sourceName) }, tokenPathDependsOnCwd(destinationToken));
    }
  } else {
    const follow = command === "cp" || command === "install";
    const destination = follow ? literalPath(destinationToken, cwd, true) : destinationEntry;
    if (destination) pushAccess(accesses, { operation: "write", path: destination }, tokenPathDependsOnCwd(destinationToken));
  }
  return accesses;
}

function literalBasename(token: Token, cwd: string): string | undefined {
  if (token.unquotedPattern) return undefined;
  const tildeExpansion = token.leadingTilde && (token.value === "~" || token.value.startsWith("~/"));
  const fixedVariableExpansion = !token.literal && FIXED_VARIABLE.test(token.value);
  const fixed = tildeExpansion || fixedVariableExpansion ? expandFixedPath(token.value, cwd) : undefined;
  if (!token.literal && fixed === undefined) return undefined;
  if (!token.quoted && !token.escaped && DYNAMIC_PATTERN.test(token.value) && fixed === undefined) return undefined;
  return path.basename((fixed ?? token.value).replace(/\/+$/, ""));
}

function tarAccesses(args: Token[], cwd: string, state: DescriptorState): BashAccess[] {
  const first = args[0]?.value ?? "";
  const oldStyleOptions = first.length > 0 && !first.startsWith("-") && /^[A-Za-z]+$/.test(first) ? first : "";
  let creating = false;
  let extracting = false;
  let appending = false;
  let deleting = false;
  let options = true;
  const consumed = new Set<number>();
  const archivePaths: Token[] = [];
  const directoryPaths: Token[] = [];
  const inputListPaths: Token[] = [];

  const consumeShortValue = (index: number, body: string, optionIndex: number, target: Token[]): boolean => {
    const tail = body.slice(optionIndex + 1);
    if (tail.length > 0) {
      target.push({ ...args[index]!, value: tail });
      return true;
    }
    const token = args[index + 1];
    if (!token) return false;
    consumed.add(index + 1);
    target.push(token);
    return true;
  };
  const parseShortBundle = (index: number, body: string): boolean => {
    for (let offset = 0; offset < body.length; offset += 1) {
      const option = body[offset]!;
      if (option === "c") creating = true;
      else if (option === "x") extracting = true;
      else if (["r", "u", "A"].includes(option)) appending = true;
      else if ("vzkjJ".includes(option)) continue;
      else if (option === "f") return consumeShortValue(index, body, offset, archivePaths);
      else if (option === "C") return consumeShortValue(index, body, offset, directoryPaths);
      else if (["T", "X"].includes(option)) return consumeShortValue(index, body, offset, inputListPaths);
      else if (option === "I") return false;
      else return false;
    }
    return true;
  };

  for (let i = 0; i < args.length; i += 1) {
    if (consumed.has(i)) continue;
    const value = args[i]!.value;
    if (options && value === "--") {
      consumed.add(i);
      options = false;
      continue;
    }
    if (!options) continue;
    if (i === 0 && oldStyleOptions) {
      consumed.add(i);
      if (!parseShortBundle(i, oldStyleOptions)) {
        state.supported = false;
        return [];
      }
      continue;
    }
    if (["-f", "--file"].includes(value)) {
      consumed.add(i);
      const token = args[i + 1];
      if (!token) {
        state.supported = false;
        return [];
      }
      consumed.add(i + 1);
      archivePaths.push(token);
      continue;
    }
    if (value.startsWith("--file=")) {
      consumed.add(i);
      archivePaths.push({ ...args[i]!, value: value.slice("--file=".length) });
      continue;
    }
    if (["-C", "--directory"].includes(value)) {
      consumed.add(i);
      const token = args[i + 1];
      if (!token) {
        state.supported = false;
        return [];
      }
      consumed.add(i + 1);
      directoryPaths.push(token);
      continue;
    }
    if (value.startsWith("--directory=")) {
      consumed.add(i);
      directoryPaths.push({ ...args[i]!, value: value.slice("--directory=".length) });
      continue;
    }
    if (["-T", "--files-from", "-X", "--exclude-from"].includes(value)) {
      consumed.add(i);
      const token = args[i + 1];
      if (!token) {
        state.supported = false;
        return [];
      }
      consumed.add(i + 1);
      inputListPaths.push(token);
      continue;
    }
    if (["--exclude", "--transform"].includes(value)) {
      consumed.add(i);
      if (!args[i + 1]) {
        state.supported = false;
        return [];
      }
      consumed.add(i + 1);
      continue;
    }
    if (["-I", "--use-compress-program"].includes(value) || value.startsWith("--use-compress-program=")) {
      state.supported = false;
      return [];
    }
    if (/^-[^-]+/.test(value)) {
      consumed.add(i);
      if (!parseShortBundle(i, value.slice(1))) {
        state.supported = false;
        return [];
      }
      continue;
    }
    if (value === "--create") creating = true;
    else if (value === "--extract") extracting = true;
    else if (["--append", "--update", "--concatenate", "--catenate"].includes(value)) appending = true;
    else if (value === "--delete") deleting = true;
    else if (!["--gzip", "--bzip2", "--xz", "--verbose"].includes(value) && value.startsWith("--")) {
      state.supported = false;
      return [];
    }
    if (value.startsWith("--")) consumed.add(i);
  }

  const accesses: BashAccess[] = [];
  const writesArchive = creating || appending || deleting;
  const readsInputFiles = creating || appending;
  if (extracting && directoryPaths.length === 0) pushAccess(accesses, { operation: "write", path: cwd }, true);
  for (const token of archivePaths) add(accesses, token, writesArchive ? "write" : "read", cwd, true);
  for (const token of directoryPaths) add(accesses, token, extracting ? "write" : "read", cwd, true);
  for (const token of inputListPaths) add(accesses, token, "read", cwd, true);
  if (readsInputFiles) {
    let afterSeparator = false;
    for (let i = 0; i < args.length; i += 1) {
      const token = args[i]!;
      if (token.value === "--") {
        afterSeparator = true;
        continue;
      }
      if (consumed.has(i) || (!afterSeparator && token.value.startsWith("-")) || isRemote(token.value)) continue;
      add(accesses, token, "read", cwd);
    }
  }
  return accesses;
}

const FIND_TESTS_WITH_VALUE = new Set([
  "-amin", "-anewer", "-atime", "-cmin", "-cnewer", "-ctime", "-fstype", "-gid", "-group",
  "-ilname", "-iname", "-inum", "-ipath", "-iregex", "-links", "-lname", "-maxdepth", "-mindepth", "-mmin",
  "-mtime", "-name", "-newer", "-path", "-perm", "-printf", "-regex", "-samefile", "-size", "-type", "-uid", "-user", "-xtype",
]);

interface FindTargetFacts {
  supported: boolean;
  targetIndexes: number[];
  expressionStart: number;
}

function findTargetFacts(args: Token[]): FindTargetFacts {
  const targetIndexes: number[] = [];
  let index = 0;
  while (index < args.length) {
    const value = args[index]!.value;
    if (value === "--") {
      index += 1;
      break;
    }
    if (["-H", "-L", "-P"].includes(value)) {
      index += 1;
      continue;
    }
    if (process.platform === "darwin" && /^-[EXdsx]+$/.test(value)) {
      index += 1;
      continue;
    }
    if (process.platform === "darwin" && value === "-f") {
      if (!args[index + 1] || args[index + 1]!.value === "--") return { supported: false, targetIndexes: [], expressionStart: args.length };
      targetIndexes.push(index + 1);
      index += 2;
      continue;
    }
    if (process.platform !== "darwin" && value === "-D") {
      if (!args[index + 1] || args[index + 1]!.value === "--") return { supported: false, targetIndexes: [], expressionStart: args.length };
      index += 2;
      continue;
    }
    if (process.platform !== "darwin" && /^-O[0-3]$/.test(value)) {
      index += 1;
      continue;
    }
    break;
  }

  while (index < args.length) {
    const value = args[index]!.value;
    if (value.startsWith("-") || value === "(" || value === "!" || value === ")") break;
    targetIndexes.push(index);
    index += 1;
  }
  return { supported: true, targetIndexes, expressionStart: index };
}

function findHasDestructiveAction(args: Token[], expressionStart: number): boolean {
  for (let i = expressionStart; i < args.length; i += 1) {
    const value = args[i]!.value;
    if (FIND_TESTS_WITH_VALUE.has(value) || /^-newer[A-Za-z]{2}$/.test(value)) {
      i += 1;
      continue;
    }
    if (["-fprint", "-fprint0", "-fls"].includes(value)) {
      i += 1;
      continue;
    }
    if (value === "-fprintf") {
      i += 2;
      continue;
    }
    if (["-exec", "-execdir", "-ok", "-okdir"].includes(value)) {
      if (value === "-exec" && args[i + 1]?.value === "rm" && args[i + 1]?.literal) return true;
      while (i + 1 < args.length && ![";", "+"].includes(args[i + 1]!.value)) i += 1;
      continue;
    }
    if (value === "-delete") return true;
  }
  return false;
}

function findTargetOperation(args: Token[]): BashAccessOperation {
  const facts = findTargetFacts(args);
  return facts.supported && findHasDestructiveAction(args, facts.expressionStart) ? "delete" : "read";
}

interface CommandPrimary {
  kind: "terminating" | "shell-payload" | "script" | "inline" | "none" | "unsupported";
  token?: Token;
}

function terminatingInterpreterOption(command: string, value: string): boolean {
  if (SHELLS.has(command)) return value === "--version" || value === "--help";
  if (command === "python" || command === "python3") return ["--version", "-V", "--help", "-h"].includes(value);
  if (command === "node") return ["--version", "-v", "--help", "-h"].includes(value);
  if (command === "ruby") return value === "--version" || value === "--help";
  if (command === "perl") return ["--version", "-v", "--help"].includes(value);
  if (command === "bun") return value === "--version" || value === "-v";
  if (command === "deno") return value === "--version" || value === "--help";
  return false;
}

function classifyCommandPrimary(command: string, args: Token[], state: DescriptorState): CommandPrimary {
  const contract: PositionalContract = command === "python" || command === "python3"
    ? {
        valueOptions: new Set(["--check-hash-based-pycs"]),
        flagOptions: new Set(["--help", "--version", "--isolated", "--no-site", "--no-user-site", "--ignore-environment", "--verbose", "--quiet"]),
        shortFlags: "bBdEhiIOqRsSuvVx",
        shortValueFlags: "WXPQ",
      }
    : command === "node" || command === "bun" || command === "deno"
      ? {
          valueOptions: new Set(["--require", "--loader", "--import", "--conditions", "--inspect-port", "--input-type", "--title", "--env-file"]),
          flagOptions: new Set(["--check", "--version", "--help", "--no-warnings", "--trace-warnings", "--experimental-strip-types", "--watch"]),
          shortFlags: "chipv",
          shortValueFlags: "r",
        }
      : SHELLS.has(command)
        ? {
            valueOptions: new Set(["--rcfile", "--init-file"]),
            flagOptions: new Set(["--noprofile", "--norc", "--posix", "--restricted", "--verbose", "--version", "--login"]),
            shortFlags: "abefhkmnptuvxBCHPl",
            shortValueFlags: "Oo",
          }
        : {
            valueOptions: new Set(["--encoding", "--external-encoding", "--internal-encoding"]),
            flagOptions: new Set(["--disable-gems", "--enable-frozen-string-literal", "--verbose", "--version", "--help"]),
            shortFlags: "acdlnpsvw",
            shortValueFlags: "CFIirx",
          };
  for (let i = 0; i < args.length;) {
    const token = args[i]!;
    const value = token.value;
    if (value === "--") return args[i + 1] ? { kind: "script", token: args[i + 1] } : { kind: "none" };
    if (value === "-" || !value.startsWith("-")) return { kind: "script", token };
    if (terminatingInterpreterOption(command, value)) return { kind: "terminating" };

    if (SHELLS.has(command) && /^-[^-]+$/.test(value)) {
      const body = value.slice(1);
      if ([...body].some((flag) => !"abefhkmnptuvxBCHPlcOo".includes(flag))) {
        state.supported = false;
        return { kind: "unsupported" };
      }
      if (body.includes("c")) {
        if (!args[i + 1]) state.supported = false;
        return args[i + 1] ? { kind: "shell-payload", token: args[i + 1] } : { kind: "unsupported" };
      }
    }

    const inline = !SHELLS.has(command) && (["-c", "-e", "--eval", "--print"].includes(value)
      || (/^-[ce].+/.test(value) && !value.startsWith("--")));
    const module = (command === "python" || command === "python3")
      && (value === "-m" || value.startsWith("-m"));
    if (inline || module) return { kind: "inline" };

    if (value.startsWith("--")) {
      const equals = value.indexOf("=");
      const name = equals >= 0 ? value.slice(0, equals) : value;
      if (contract.valueOptions?.has(name)) {
        if ((equals < 0 && args[i + 1] === undefined) || equals === value.length - 1) {
          state.supported = false;
          return { kind: "unsupported" };
        }
        i += equals < 0 ? 2 : 1;
        continue;
      }
      if (contract.optionalValueOptions?.has(name) || contract.flagOptions?.has(name)) {
        i += 1;
        continue;
      }
      state.supported = false;
      return { kind: "unsupported" };
    }

    const body = value.slice(1);
    let consumedNext = false;
    for (let offset = 0; offset < body.length; offset += 1) {
      const flag = body[offset]!;
      if (contract.shortFlags?.includes(flag)) continue;
      if (contract.shortValueFlags?.includes(flag)) {
        consumedNext = offset === body.length - 1;
        if (consumedNext && args[i + 1] === undefined) {
          state.supported = false;
          return { kind: "unsupported" };
        }
        break;
      }
      if (contract.shortOptionalValueFlags?.includes(flag)) break;
      state.supported = false;
      return { kind: "unsupported" };
    }
    i += consumedNext ? 2 : 1;
  }
  return { kind: "none" };
}

function interpreterScript(command: string, args: Token[], state: DescriptorState): Token | undefined {
  const primary = classifyCommandPrimary(command, args, state);
  return primary.kind === "script" ? primary.token : undefined;
}

interface GitGlobalFacts {
  supported: boolean;
  cwdValues: Token[];
  subcommandIndex?: number;
  pathspecMode?: GitPathspecMode;
}

function gitPathspecEnvironment(assignments: Token[], inheritedSupported = true): {
  supported: boolean;
  literal: boolean;
  glob: boolean;
  noglob: boolean;
  icase: boolean;
} {
  if (!inheritedSupported) return { supported: false, literal: false, glob: false, noglob: false, icase: false };
  const values = new Map<string, boolean>();
  const names = new Set(["GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"]);
  for (const assignment of assignments) {
    const equals = assignment.value.indexOf("=");
    const name = assignment.value.slice(0, equals);
    if (!names.has(name)) continue;
    const value = assignment.value.slice(equals + 1);
    if (!assignment.literal || (value !== "0" && value !== "1")) {
      return { supported: false, literal: false, glob: false, noglob: false, icase: false };
    }
    values.set(name, value === "1");
  }
  return {
    supported: true,
    literal: values.get("GIT_LITERAL_PATHSPECS") ?? false,
    glob: values.get("GIT_GLOB_PATHSPECS") ?? false,
    noglob: values.get("GIT_NOGLOB_PATHSPECS") ?? false,
    icase: values.get("GIT_ICASE_PATHSPECS") ?? false,
  };
}

function gitGlobalFacts(args: Token[], assignments: Token[], assignmentEnvironmentSupported: boolean): GitGlobalFacts {
  const cwdValues: Token[] = [];
  const environment = gitPathspecEnvironment(assignments, assignmentEnvironmentSupported);
  let literal = environment.literal;
  let glob = environment.glob;
  let noglob = environment.noglob;
  let icase = environment.icase;
  const required = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
  const transparentFlags = new Set([
    "-p", "--paginate", "-P", "--no-pager", "--bare", "--no-replace-objects", "--no-lazy-fetch",
    "--no-optional-locks", "--no-advice",
  ]);
  const terminating = new Set(["-v", "--version", "-h", "--help", "--html-path", "--man-path", "--info-path", "--exec-path"]);
  const attachedLong = ["--git-dir=", "--work-tree=", "--namespace=", "--super-prefix=", "--config-env=", "--exec-path="];
  const finish = (subcommandIndex?: number): GitGlobalFacts => {
    const supported = environment.supported && !(literal && (glob || icase)) && !(glob && noglob);
    return {
      supported,
      cwdValues: supported ? cwdValues : [],
      ...(supported && subcommandIndex !== undefined ? { subcommandIndex } : {}),
      ...(supported ? { pathspecMode: literal ? "literal" : noglob ? "noglob" : "default" } : {}),
    };
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    const value = token.value;
    if (value === "--") return finish(args[index + 1] ? index + 1 : undefined);
    if (terminating.has(value)) return finish();
    if (required.has(value)) {
      const optionValue = args[index + 1];
      if (!optionValue) return { supported: false, cwdValues: [] };
      if (value === "-C") cwdValues.push(optionValue);
      index += 1;
      continue;
    }
    if (value.startsWith("-C") && value.length > 2) {
      cwdValues.push({ ...token, value: value.slice(2) });
      continue;
    }
    if (value.startsWith("-c") && value.length > 2) continue;
    const attached = attachedLong.find((prefix) => value.startsWith(prefix));
    if (attached) {
      if (value.length === attached.length) return { supported: false, cwdValues: [] };
      continue;
    }
    if (value === "--literal-pathspecs") {
      literal = true;
      continue;
    }
    if (value === "--glob-pathspecs") {
      glob = true;
      continue;
    }
    if (value === "--noglob-pathspecs") {
      noglob = true;
      continue;
    }
    if (value === "--icase-pathspecs") {
      icase = true;
      continue;
    }
    if (transparentFlags.has(value)) continue;
    if (value.startsWith("-")) return { supported: false, cwdValues: [] };
    return finish(index);
  }
  return finish();
}

function deriveAccesses(
  command: string,
  argvTokens: Token[],
  redirects: Array<{ op: BashAccessOperation; token: Token }>,
  cwd: string,
  assignments: Token[] = [],
  assignmentEnvironmentSupported = true,
): {
  accesses: BashAccess[];
  descriptorSupported: boolean;
  remoteDestination: boolean;
  recursive: boolean;
  targetArgvIndexes?: number[];
  gitGlobalShapeSupported?: boolean;
  gitSubcommandIndex?: number;
  gitPathspecMode?: GitPathspecMode;
} {
  const args = argvTokens.slice(1);
  const redirectAccesses: BashAccess[] = [];
  const accesses: BashAccess[] = [];
  const descriptorState: DescriptorState = { supported: true };
  let remoteDestination = false;
  let recursive = false;
  let targetArgvIndexes: number[] | undefined;
  let gitGlobalShapeSupported: boolean | undefined;
  let gitSubcommandIndex: number | undefined;
  let gitPathspecMode: GitPathspecMode | undefined;
  const operandsOf = (tokens: Token[], contract: PositionalContract = {}) => positionals(tokens, contract, descriptorState);
  for (const redirect of redirects) add(redirectAccesses, redirect.token, redirect.op, cwd, redirect.op === "read" || redirect.op === "write");

  if (command === "cd") add(accesses, operandsOf(args)[0], "read", cwd);
  if (command === "source" || command === ".") add(accesses, sourceScript(args, descriptorState), "read", cwd);
  if (command === "ls" && !args.some((token) => token.value === "--help" || token.value === "--version")) {
    for (const token of operandsOf(args, {
      valueOptions: new Set(["--ignore", "--hide", "--sort", "--time", "--format", "--quoting-style", "--block-size", "--time-style", "--indicator-style", "--width", "--tabsize"]),
      optionalValueOptions: new Set(["--color", "--hyperlink"]),
      flagOptions: new Set(["--all", "--almost-all", "--directory", "--classify", "--human-readable", "--inode", "--numeric-uid-gid", "--recursive", "--reverse", "--size", "--version", "--help"]),
      shortFlags: process.platform === "darwin" ? "aAbBcCdDfFghHiklLmnopqQrSsuUvwWxX1" : "aAbBcCdDfFghHiklLmnopqQrSsuUvWxX1",
      shortValueFlags: process.platform === "darwin" ? "IT" : "IwT",
    })) add(accesses, token, "read", cwd);
  }
  if (command === "cat") for (const token of operandsOf(args, {
    flagOptions: new Set(["--show-all", "--number-nonblank", "--show-ends", "--number", "--squeeze-blank", "--show-tabs", "--show-nonprinting"]),
    shortFlags: "AbeEnstTuv",
  })) add(accesses, token, "read", cwd);
  if (["head", "tail"].includes(command)) for (const token of operandsOf(args, {
    valueOptions: new Set(["--lines", "--bytes", "--sleep-interval", "--pid", "--max-unchanged-stats"]),
    flagOptions: new Set(["--quiet", "--silent", "--verbose", "--follow", "--retry", "--zero-terminated"]),
    shortFlags: "qvFfz",
    shortValueFlags: "ncsp",
  })) add(accesses, token, "read", cwd);
  if (["grep", "rg"].includes(command)) {
    const parsed = parseOptions(args, {
      valueOptions: new Set(["--regexp", "--file", "--glob", "--max-count", "--after-context", "--before-context", "--context", "--include", "--exclude", "--exclude-from", "--exclude-dir", "--label", "--binary-files", "--devices", "--directories", "--type", "--type-add", "--encoding", "--engine", "--sort", "--sortr", "--replace", "--pre", "--max-filesize"]),
      optionalValueOptions: new Set(["--color", "--colour"]),
      flagOptions: new Set(["--fixed-strings", "--ignore-case", "--invert-match", "--line-number", "--recursive", "--word-regexp", "--line-regexp", "--hidden", "--no-ignore", "--files-with-matches", "--files-without-match", "--count", "--quiet", "--text"]),
      shortFlags: "EFGHILPRSUchilnoqsvwx",
      shortValueFlags: "efgmABCjtT",
    }, descriptorState);
    if (parsed.supported) {
      for (const { option, value } of parsed.optionValues) if (option === "-f" || option === "--file") add(accesses, value, "read", cwd);
      const explicitPattern = parsed.optionValues.some(({ option }) => ["-e", "--regexp", "-f", "--file"].includes(option));
      for (const token of explicitPattern ? parsed.positionals : parsed.positionals.slice(1)) add(accesses, token, "read", cwd);
    }
  }
  if (command === "find") {
    const facts = findTargetFacts(args);
    if (!facts.supported) descriptorState.supported = false;
    const destructive = facts.supported && findHasDestructiveAction(args, facts.expressionStart);
    for (const index of facts.targetIndexes) {
      const token = args[index]!;
      add(accesses, token, destructive ? "delete" : "read", cwd, !destructive || forcesDirectoryTraversal(token.value));
    }
  }
  if (command === "sed") {
    const parsed = parseOptions(args, {
      valueOptions: new Set(["--expression", "--file", "--line-length"]),
      flagOptions: new Set(["--quiet", "--silent", "--regexp-extended", "--separate", "--unbuffered", "--null-data"]),
      optionalValueOptions: new Set(["--in-place"]),
      shortFlags: "nErsuz",
      shortValueFlags: "efl",
      shortOptionalValueFlags: "i",
    }, descriptorState);
    if (parsed.supported) {
      for (const { option, value } of parsed.optionValues) if (option === "-f" || option === "--file") add(accesses, value, "read", cwd);
      const explicitScript = parsed.optionValues.some(({ option }) => ["-e", "--expression", "-f", "--file"].includes(option));
      const inPlace = parsed.flags.has("-i") || parsed.flags.has("--in-place")
        || parsed.optionValues.some(({ option }) => option === "-i" || option === "--in-place");
      for (const token of explicitScript ? parsed.positionals : parsed.positionals.slice(1)) {
        add(accesses, token, "read", cwd);
        if (inPlace) add(accesses, token, "write", cwd, true);
      }
    }
  }
  if (command === "rm") {
    for (const token of operandsOf(args, {
      optionalValueOptions: new Set(["--interactive", "--preserve-root"]),
      flagOptions: new Set(["--force", "--one-file-system", "--no-preserve-root", "--recursive", "--dir", "--verbose"]),
      shortFlags: process.platform === "darwin" ? "dfiIPRrvWx" : "dfiIRrv",
    })) {
      const entryToken = rmDeleteToken(token);
      add(accesses, entryToken, "delete", cwd, entryToken.value === token.value && token.value.endsWith("/"));
    }
  }
  if (command === "rmdir") for (const token of operandsOf(args, {
    flagOptions: new Set(["--ignore-fail-on-non-empty", "--parents", "--verbose"]),
    shortFlags: "pv",
  })) add(accesses, token, "delete", cwd, token.value.endsWith("/"));
  if (["cp", "install", "mv", "ln"].includes(command)) accesses.push(...destinationAccesses(command as "cp" | "install" | "mv" | "ln", args, cwd, descriptorState));
  if (["tee", "truncate", "touch", "chmod", "chown"].includes(command)) {
    const contract: PositionalContract = command === "touch"
      ? {
          valueOptions: new Set(["--date", "--reference"]),
          flagOptions: new Set(["--no-create", "--no-dereference"]),
          shortFlags: "acmh",
          shortValueFlags: "drt",
        }
      : command === "truncate"
        ? {
            valueOptions: new Set(["--reference", "--size", "--io-blocks"]),
            flagOptions: new Set(["--no-create"]),
            shortFlags: "co",
            shortValueFlags: "rs",
          }
        : command === "chmod"
          ? {
              valueOptions: new Set(["--reference"]),
              flagOptions: new Set(["--changes", "--quiet", "--silent", "--verbose", "--no-preserve-root", "--preserve-root", "--recursive"]),
              shortFlags: process.platform === "darwin" ? "fhvRHLPECNiI" : "cfvR",
              firstDashPositionalPattern: /^(?:[ugoa]*(?:[+=][rwxXstugo]*|-[rwxXstugo]+))(?:,[ugoa]*(?:[+=][rwxXstugo]*|-[rwxXstugo]+))*$/,
            }
          : command === "chown"
            ? {
                valueOptions: new Set(["--reference", "--from"]),
                flagOptions: new Set(["--changes", "--dereference", "--no-dereference", "--quiet", "--silent", "--verbose", "--no-preserve-root", "--preserve-root", "--recursive"]),
                shortFlags: process.platform === "darwin" ? "fhnvxRHLP" : "cfhvRHLPR",
              }
            : {
                flagOptions: new Set(["--append", "--ignore-interrupts"]),
                shortFlags: "ai",
              };
    const parsed = parseOptions(args, contract, descriptorState);
    if (parsed.supported) {
      const references = parsed.optionValues.filter(({ option }) => option === "-r" || option === "--reference");
      for (const { value } of references) add(accesses, value, "read", cwd);
      const hasReference = references.length > 0;
      const chmodAction = command === "chmod" && process.platform === "darwin"
        && ["-E", "-C", "-N", "-i", "-I"].some((flag) => parsed.flags.has(flag));
      const targetOffset = command === "chown" && !hasReference
        ? 1
        : command === "chmod" && !hasReference && !chmodAction ? 1 : 0;
      const targets = parsed.positionals.slice(targetOffset);
      for (const token of targets) add(accesses, token, "write", cwd, true);
      if (command === "chmod" || command === "chown") {
        recursive = parsed.flags.has("-R") || parsed.flags.has("--recursive");
        targetArgvIndexes = parsed.positionalIndexes.slice(targetOffset).map((index) => index + 1);
      }
    }
  }
  if (command === "mkdir") for (const token of operandsOf(args, {
    valueOptions: new Set(["--mode", "--context"]),
    flagOptions: new Set(["--parents", "--verbose"]),
    shortFlags: "pvZ",
    shortValueFlags: "m",
  })) add(accesses, token, "write", cwd, false);
  if (command === "dd") {
    const terminating = args.some((token) => token.value === "--help" || token.value === "--version");
    const knownOperands = new Set(["if", "of", "ibs", "obs", "bs", "cbs", "skip", "seek", "count", "conv", "iflag", "oflag", "status"]);
    const parsed = terminating ? [] : args.map((token) => {
      const equals = token.value.indexOf("=");
      const name = equals < 0 ? "" : token.value.slice(0, equals);
      return { token, name, value: equals < 0 ? "" : token.value.slice(equals + 1) };
    });
    if (!terminating && parsed.some(({ name, value }) => !knownOperands.has(name) || value.length === 0)) {
      descriptorState.supported = false;
    } else if (!terminating) {
      for (const { token, name, value } of parsed) {
        if (name === "if") add(accesses, { ...token, value, leadingTilde: token.assignmentValueLeadingTilde === true }, "read", cwd);
        if (name === "of") add(accesses, { ...token, value, leadingTilde: token.assignmentValueLeadingTilde === true }, "write", cwd, true);
      }
    }
  }
  if (["shred", "badblocks", "wipefs", "fdisk", "gdisk", "parted", "blkdiscard"].includes(command)
    || command === "mkfs" || command.startsWith("mkfs.")) {
    const contract: PositionalContract = command === "shred"
      ? {
          valueOptions: new Set(["--iterations", "--size", "--random-source"]),
          flagOptions: new Set(["--force", "--remove", "--zero", "--verbose", "--exact"]),
          shortFlags: "fuvxz",
          shortValueFlags: "ns",
        }
      : command === "badblocks"
        ? {
            valueOptions: new Set(["--block-size", "--count", "--max-bad-blocks", "--input-file", "--output-file", "--passes", "--test-pattern"]),
            flagOptions: new Set(["--force", "--non-destructive", "--show-progress", "--verbose", "--write-mode"]),
            shortFlags: "fnsvw",
            shortValueFlags: "bceiopt",
          }
        : command === "wipefs"
          ? {
              valueOptions: new Set(["--offset", "--types"]),
              flagOptions: new Set(["--all", "--force", "--no-act", "--quiet", "--version", "--json"]),
              shortFlags: "afnqVJ",
              shortValueFlags: "ot",
            }
          : command === "fdisk"
            ? { flagOptions: new Set(["--list"]), shortFlags: "l", shortValueFlags: "bCHS" }
            : command === "gdisk"
              ? { shortFlags: "l" }
              : command === "parted"
                ? {
                    valueOptions: new Set(["--align"]),
                    flagOptions: new Set(["--script", "--list", "--machine", "--json", "--fix"]),
                    shortFlags: "slmjf",
                    shortValueFlags: "a",
                  }
                : command === "blkdiscard"
                  ? {
                      valueOptions: new Set(["--offset", "--length", "--step"]),
                      flagOptions: new Set(["--force", "--secure", "--verbose", "--zeroout"]),
                      shortFlags: "fsvz",
                      shortValueFlags: "olp",
                    }
                  : {
                      valueOptions: new Set(["--type", "--label"]),
                      flagOptions: new Set(["--verbose", "--version"]),
                      shortFlags: "Vv",
                      shortValueFlags: "tL",
                    };
    const parsed = parseOptions(args, contract, descriptorState);
    const targets = parsed.positionals;
    const deviceTargets = ["shred", "wipefs"].includes(command) ? targets : targets.slice(0, 1);
    let operation: BashAccessOperation = "write";
    if (command === "badblocks") {
      operation = parsed.flags.has("-w") || parsed.flags.has("--write-mode") ? "write" : "read";
    } else if (
      (command === "wipefs" && (parsed.flags.has("-n") || parsed.flags.has("--no-act")))
      || (command === "fdisk" && (parsed.flags.has("-l") || parsed.flags.has("--list")))
      || (command === "gdisk" && parsed.flags.has("-l"))
      || (command === "parted" && (parsed.flags.has("-l") || parsed.flags.has("--list")))
    ) {
      operation = "read";
    }
    const terminating = (command === "wipefs" && (parsed.flags.has("-V") || parsed.flags.has("--version")))
      || ((command === "mkfs" || command.startsWith("mkfs.")) && parsed.flags.has("--version"));
    if (!terminating) for (const token of deviceTargets) add(accesses, token, operation, cwd, true);
  }
  if (command === "curl") {
    const flagOptions = new Set(["--silent", "--show-error", "--location", "--fail", "--fail-with-body", "--compressed", "--insecure", "--head", "--include", "--verbose"]);
    const valueOptions = new Set(["--header", "--user-agent", "--request", "--user", "--proxy", "--connect-timeout", "--max-time", "--retry"]);
    const shortFlags = "sSLfkIiv";
    const shortValueFlags = "HAXux";
    const formFilePath = (form: string): string | undefined => {
      const marker = form.indexOf("=@");
      if (marker < 0) return undefined;
      let result = "";
      let escaped = false;
      for (const char of form.slice(marker + 2)) {
        if (escaped) {
          result += char;
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === ";") {
          break;
        } else {
          result += char;
        }
      }
      if (escaped) result += "\\";
      return result;
    };
    const descriptorAccesses: BashAccess[] = [];
    let options = true;
    let supported = true;
    for (let i = 0; i < args.length; i += 1) {
      const token = args[i]!;
      const value = token.value;
      if (options && value === "--") {
        options = false;
        continue;
      }
      if (!options || value === "-" || !value.startsWith("-")) continue;

      if (["-o", "--output", "-T", "--upload-file", "-d", "--data", "--data-binary", "-F", "--form"].includes(value)) {
        const optionValue = args[++i];
        if (!optionValue) {
          supported = false;
          break;
        }
        if (["-o", "--output"].includes(value)) add(descriptorAccesses, optionValue, "write", cwd, true);
        else if (["-T", "--upload-file"].includes(value)) add(descriptorAccesses, optionValue, "read", cwd);
        else if (["-d", "--data", "--data-binary"].includes(value) && optionValue.value.startsWith("@")) {
          add(descriptorAccesses, { ...optionValue, value: optionValue.value.slice(1) }, "read", cwd);
        } else if (["-F", "--form"].includes(value)) {
          const file = formFilePath(optionValue.value);
          if (file !== undefined) add(descriptorAccesses, { ...optionValue, value: file }, "read", cwd);
        }
        continue;
      }
      if (value.startsWith("--output=")) add(descriptorAccesses, { ...token, value: value.slice("--output=".length) }, "write", cwd, true);
      else if (/^-o.+/.test(value)) add(descriptorAccesses, { ...token, value: value.slice(2) }, "write", cwd, true);
      else if (value.startsWith("--upload-file=")) add(descriptorAccesses, { ...token, value: value.slice("--upload-file=".length) }, "read", cwd);
      else if (/^-T.+/.test(value)) add(descriptorAccesses, { ...token, value: value.slice(2) }, "read", cwd);
      else if (["--data", "--data-binary"].some((option) => value.startsWith(`${option}=`))) {
        const data = value.slice(value.indexOf("=") + 1);
        if (data.startsWith("@")) add(descriptorAccesses, { ...token, value: data.slice(1) }, "read", cwd);
      } else if (/^-d.+/.test(value)) {
        const data = value.slice(2);
        if (data.startsWith("@")) add(descriptorAccesses, { ...token, value: data.slice(1) }, "read", cwd);
      } else if (value.startsWith("--form=") || /^-F.+/.test(value)) {
        const form = value.startsWith("--form=") ? value.slice("--form=".length) : value.slice(2);
        const file = formFilePath(form);
        if (file !== undefined) add(descriptorAccesses, { ...token, value: file }, "read", cwd);
      } else if (flagOptions.has(value)) {
        continue;
      } else if (valueOptions.has(value)) {
        const optionValue = args[++i];
        if (!optionValue) {
          supported = false;
          break;
        }
        if (["--header"].includes(value) && optionValue.value.startsWith("@")) {
          add(descriptorAccesses, { ...optionValue, value: optionValue.value.slice(1) }, "read", cwd);
        }
      } else if ([...valueOptions].some((option) => value.startsWith(`${option}=`))) {
        const optionValue = value.slice(value.indexOf("=") + 1);
        if (value.startsWith("--header=") && optionValue.startsWith("@")) {
          add(descriptorAccesses, { ...token, value: optionValue.slice(1) }, "read", cwd);
        }
      } else if (/^-[^-]+/.test(value)) {
        const body = value.slice(1);
        for (let offset = 0; offset < body.length; offset += 1) {
          const flag = body[offset]!;
          if (shortFlags.includes(flag)) continue;
          if (shortValueFlags.includes(flag)) {
            const attached = body.slice(offset + 1);
            const optionValue = attached.length > 0 ? { ...token, value: attached } : args[++i];
            if (!optionValue) supported = false;
            else if (flag === "H" && optionValue.value.startsWith("@")) {
              add(descriptorAccesses, { ...optionValue, value: optionValue.value.slice(1) }, "read", cwd);
            }
            offset = body.length;
            continue;
          }
          supported = false;
          break;
        }
        if (!supported) break;
      } else {
        supported = false;
        break;
      }
    }
    if (supported) accesses.push(...descriptorAccesses);
    else descriptorState.supported = false;
  }
  if (command === "wget") {
    const flagOptions = new Set(["--quiet", "--verbose", "--no-verbose", "--continue", "--spider", "--timestamping"]);
    const valueOptions = new Set(["--timeout", "--tries", "--wait", "--user-agent", "--header"]);
    const shortFlags = "qvncN";
    const shortValueFlags = "tTw";
    const descriptorAccesses: BashAccess[] = [];
    let options = true;
    let supported = true;
    for (let i = 0; i < args.length; i += 1) {
      const token = args[i]!;
      const value = token.value;
      if (options && value === "--") {
        options = false;
        continue;
      }
      if (!options || value === "-" || !value.startsWith("-")) continue;

      if (["-O", "--output-document", "--post-file", "--body-file"].includes(value)) {
        const optionValue = args[++i];
        if (!optionValue) {
          supported = false;
          break;
        }
        add(descriptorAccesses, optionValue, ["-O", "--output-document"].includes(value) ? "write" : "read", cwd, true);
        continue;
      }
      if (value.startsWith("--output-document=")) add(descriptorAccesses, { ...token, value: value.slice("--output-document=".length) }, "write", cwd, true);
      else if (/^-O.+/.test(value)) add(descriptorAccesses, { ...token, value: value.slice(2) }, "write", cwd, true);
      else if (["--post-file=", "--body-file="].some((option) => value.startsWith(option))) {
        add(descriptorAccesses, { ...token, value: value.slice(value.indexOf("=") + 1) }, "read", cwd);
      } else if (flagOptions.has(value)) {
        continue;
      } else if (valueOptions.has(value)) {
        if (!args[++i]) {
          supported = false;
          break;
        }
      } else if ([...valueOptions].some((option) => value.startsWith(`${option}=`))) {
        continue;
      } else if (/^-[^-]+/.test(value)) {
        const body = value.slice(1);
        for (let offset = 0; offset < body.length; offset += 1) {
          const flag = body[offset]!;
          if (shortFlags.includes(flag)) continue;
          if (shortValueFlags.includes(flag)) {
            if (offset === body.length - 1 && !args[++i]) supported = false;
            offset = body.length;
            continue;
          }
          supported = false;
          break;
        }
        if (!supported) break;
      } else {
        supported = false;
        break;
      }
    }
    if (supported) accesses.push(...descriptorAccesses);
    else descriptorState.supported = false;
  }
  if (["scp", "rsync"].includes(command)) {
    const operands = operandsOf(args, {
      valueOptions: new Set(["--rsh", "--exclude", "--include", "--exclude-from", "--include-from", "--filter", "--port", "--password-file", "--rsync-path", "--timeout", "--contimeout", "--key-file", "--identity-file"]),
      flagOptions: new Set(["--archive", "--recursive", "--verbose", "--compress", "--delete", "--dry-run", "--protect-args", "--relative", "--links", "--copy-links", "--safe-links", "--ignore-existing", "--update"]),
      shortFlags: "aCglopqrtuvz",
      shortValueFlags: "eFiJPS",
    });
    for (const token of operands.slice(0, -1)) if (!isRemote(token.value)) add(accesses, token, "read", cwd);
    const destination = operands.at(-1);
    remoteDestination = destination !== undefined && isRemote(destination.value);
    if (destination && !isRemote(destination.value)) add(accesses, destination, "write", cwd, true);
  }
  if (command === "tar") {
    accesses.push(...tarAccesses(args, cwd, descriptorState));
  }
  if (command === "git") {
    const facts = gitGlobalFacts(args, assignments, assignmentEnvironmentSupported);
    gitGlobalShapeSupported = facts.supported;
    gitSubcommandIndex = facts.subcommandIndex === undefined ? undefined : facts.subcommandIndex + 1;
    gitPathspecMode = facts.pathspecMode;
    if (!facts.supported) descriptorState.supported = false;
    else for (const value of facts.cwdValues) add(accesses, value, "read", cwd);
  }
  if (INTERPRETERS.has(command) || SHELLS.has(command)) {
    const script = interpreterScript(command, args, descriptorState);
    if (script && script.value !== "-") add(accesses, script, "execute", cwd);
  }
  const executable = argvTokens[0];
  const executableAccesses: BashAccess[] = [];
  if (executable?.value.includes("/")) add(executableAccesses, executable, "execute", cwd);
  return {
    accesses: descriptorState.supported
      ? [...redirectAccesses, ...accesses, ...executableAccesses]
      : [...redirectAccesses, ...executableAccesses],
    descriptorSupported: descriptorState.supported,
    remoteDestination,
    recursive,
    ...(targetArgvIndexes ? { targetArgvIndexes } : {}),
    ...(gitGlobalShapeSupported !== undefined ? { gitGlobalShapeSupported } : {}),
    ...(gitSubcommandIndex !== undefined ? { gitSubcommandIndex } : {}),
    ...(gitPathspecMode !== undefined ? { gitPathspecMode } : {}),
  };
}

function isRemote(value: string): boolean {
  return /^[^/\s]+:/.test(value) || /^[a-z]+:\/\//i.test(value);
}

function splitRedirections(tokens: Token[]): { argv: Token[]; redirects: Array<{ op: BashAccessOperation; token: Token }> } {
  const argv: Token[] = [];
  const redirects: Array<{ op: BashAccessOperation; token: Token }> = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (!REDIRECTS.has(token.value)) {
      argv.push(token);
      continue;
    }
    const target = tokens[++i];
    if (token.value === AMBIGUOUS_OUTPUT_REDIRECT) continue;
    if (target && !token.value.startsWith("<<") && !/^(?:&\d|\/dev\/fd\/\d)$/.test(target.value)) {
      if (token.value === "<>") redirects.push({ op: "read", token: target }, { op: "write", token: target });
      else redirects.push({ op: token.value === "<" ? "read" : "write", token: target });
    }
  }
  return { argv, redirects };
}

interface UnwrappedCommand {
  tokens: Token[];
  privilege: boolean;
  supported: boolean;
  assignments: Token[];
  assignmentEnvironmentSupported: boolean;
  shellPayload?: Token;
  shellCommand?: string;
}

function unwrap(tokens: Token[], initialAssignments: Token[] = [], initialAssignmentEnvironmentSupported = true): UnwrappedCommand {
  let current = tokens;
  let privilege = false;
  let supported = true;
  const assignments = new Map<string, Token>();
  for (const assignment of initialAssignments) assignments.set(assignment.value.slice(0, assignment.value.indexOf("=")), assignment);
  let assignmentEnvironmentSupported = initialAssignmentEnvironmentSupported;
  const result = (overrides: Partial<UnwrappedCommand> = {}): UnwrappedCommand => ({
    tokens: current,
    privilege,
    supported,
    assignments: [...assignments.values()],
    assignmentEnvironmentSupported,
    ...overrides,
  });
  while (current.length > 0) {
    if (current[0]!.value.includes("/")) break;
    const command = current[0]!.value;
    const args = current.slice(1);
    if (command === "command" || command === "exec" || command === "nohup") {
      let i = args[0]?.value === "--" ? 1 : 0;
      if (i === 0 && args[0]?.value.startsWith("-")) return result({ supported: false });
      if (!args[i]) return result({ supported: false });
      current = args.slice(i);
      continue;
    }
    if (command === "env") {
      let i = 0;
      while (i < args.length) {
        const value = args[i]!.value;
        if (value === "--") { i += 1; break; }
        if (value === "-i" || value === "--ignore-environment") {
          assignments.clear();
          assignmentEnvironmentSupported = true;
          i += 1;
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
          assignments.set(value.slice(0, value.indexOf("=")), args[i]!);
          i += 1;
          continue;
        }
        if (value.startsWith("--unset=")) {
          if (value.length === "--unset=".length) return result({ supported: false });
          const name = value.slice("--unset=".length);
          if (args[i]!.literal) assignments.delete(name);
          else assignmentEnvironmentSupported = false;
          i += 1;
          continue;
        }
        if (value === "-u") {
          if (!args[i + 1] || args[i + 1]!.value === "--") return result({ supported: false });
          if (args[i + 1]!.literal) assignments.delete(args[i + 1]!.value);
          else assignmentEnvironmentSupported = false;
          i += 2;
          continue;
        }
        if (value.startsWith("-")) return result({ supported: false });
        break;
      }
      if (!args[i]) return result({ supported: false });
      current = args.slice(i);
      continue;
    }
    if (command === "timeout") {
      let i = args[0]?.value === "--" ? 1 : 0;
      if (!args[i] || args[i]!.value.startsWith("-") || !args[i + 1]) {
        return result({ supported: false });
      }
      i += 1;
      current = args.slice(i);
      continue;
    }
    if (command === "time") {
      let i = 0;
      if (args[i]?.value === "-p") i += 1;
      if (args[i]?.value === "--") i += 1;
      else if (args[i]?.value.startsWith("-")) return result({ supported: false });
      if (!args[i]) return result({ supported: false });
      current = args.slice(i);
      continue;
    }
    if (command === "nice") {
      let i = 0;
      if (args[i]?.value === "-n") {
        if (!args[i + 1] || args[i + 1]!.value === "--") return result({ supported: false });
        i += 2;
      } else if (args[i]?.value.startsWith("--adjustment=")) {
        if (args[i]!.value.length === "--adjustment=".length) return result({ supported: false });
        i += 1;
      }
      if (args[i]?.value === "--") i += 1;
      else if (args[i]?.value.startsWith("-")) return result({ supported: false });
      if (!args[i]) return result({ supported: false });
      current = args.slice(i);
      continue;
    }
    if (SHELLS.has(command)) {
      const classificationState: DescriptorState = { supported: true };
      const primary = classifyCommandPrimary(command, args, classificationState);
      if (primary.kind === "shell-payload") {
        return primary.token?.literal
          ? result({ shellPayload: primary.token, shellCommand: command })
          : result({ supported: false });
      }
      return result({ supported: supported && classificationState.supported && primary.kind !== "unsupported" });
    }
    if (PRIVILEGE.has(command)) {
      privilege = true;
      let i = 0;
      if (["sudo", "doas", "pkexec"].includes(command)) {
        while (i < args.length) {
          const value = args[i]!.value;
          if (value === "--") { i += 1; break; }
          if (["-u", "--user", "-g", "--group"].includes(value)) {
            if (!args[i + 1] || args[i + 1]!.value === "--") return result({ supported: false });
            i += 2;
            continue;
          }
          if (value.startsWith("-")) return result({ supported: false });
          break;
        }
        if (!args[i]) return result({ supported: false });
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i]!.value)) return result({ supported: false });
        current = args.slice(i);
        continue;
      }
      if (command === "runuser") {
        let i = 0;
        if (args[i]?.value === "-u" && args[i + 1] && args[i + 1]!.value !== "--") i += 2;
        if (args[i]?.value === "--" && args[i + 1] && !args[i + 1]!.value.startsWith("-")) {
          current = args.slice(i + 1);
          continue;
        }
      }
      if (command === "su") {
        const c = args.findIndex((arg) => arg.value === "-c");
        const supportedShape = c === 0
          ? (args.length === 2 || args.length === 3)
          : c === 1 && args.length === 3 && !args[0]!.value.startsWith("-");
        if (supportedShape && args[c + 1]?.literal) {
          return result({ shellPayload: args[c + 1], shellCommand: command });
        }
      }
      if (
        command === "machinectl"
        && args[0]?.value === "shell"
        && args.length >= 3
        && !args[1]!.value.startsWith("-")
        && !args[2]!.value.startsWith("-")
      ) {
        current = args.slice(2);
        continue;
      }
      return result({ supported: false });
    }
    break;
  }
  return result();
}

function peelLeadingAssignments(tokens: Token[]): { tokens: Token[]; assignments: Token[]; dynamic: boolean } {
  let index = 0;
  let dynamic = false;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!.value)) {
    const token = tokens[index]!;
    dynamic ||= !token.literal || (!token.quoted && !token.escaped && DYNAMIC_PATTERN.test(token.value));
    index += 1;
  }
  return { tokens: tokens.slice(index), assignments: tokens.slice(0, index), dynamic };
}

function uniqueAccesses(accesses: BashAccess[]): BashAccess[] {
  return [...new Map(accesses.map((access) => [`${access.operation}\0${access.path}`, access])).values()]
    .sort((a, b) => a.operation.localeCompare(b.operation) || a.path.localeCompare(b.path));
}

interface ReachableCwd {
  cwd: string;
  uncertain: boolean;
}

function reachableCwdKey(state: ReachableCwd): string {
  return `${state.uncertain ? "1" : "0"}\0${state.cwd}`;
}

function reachableCwdFromKey(key: string): ReachableCwd {
  return { uncertain: key.startsWith("1\0"), cwd: key.slice(2) };
}

export function analyzeBash(rawCommand: string, options: AnalyzeBashOptions): BashAnalysis {
  return analyzeBashInternal(rawCommand, options);
}

function analyzeBashInternal(
  rawCommand: string,
  options: AnalyzeBashOptions,
  inheritedCwdUncertain = false,
  inheritedAssignments: Token[] = [],
  inheritedAssignmentEnvironmentSupported = true,
): BashAnalysis {
  const command = rawCommand.trim();
  const cwd = realpathNearest(path.resolve(options.workspaceRoot, options.cwd ?? "."), true) ?? path.resolve(options.workspaceRoot, options.cwd ?? ".");
  const scanned = scan(command);
  const invocations: BashInvocation[] = [];
  const initialCwd = reachableCwdKey({ cwd, uncertain: inheritedCwdUncertain });
  let successCwds = new Set([initialCwd]);
  let failureCwds = new Set([initialCwd]);
  let pipelineBase = new Set([initialCwd]);
  let nestedBackground = false;
  let nestedDynamic = false;

  for (let segmentIndex = 0; segmentIndex < scanned.segments.length; segmentIndex += 1) {
    const segment = scanned.segments[segmentIndex]!;
    const priorSuccess = new Set(successCwds);
    const priorFailure = new Set(failureCwds);
    let inputCwds: Set<string>;
    if (segmentIndex === 0) inputCwds = new Set([initialCwd]);
    else if (segment.separatorBefore === "&&") inputCwds = successCwds;
    else if (segment.separatorBefore === "||") inputCwds = failureCwds;
    else if (segment.separatorBefore === ";") inputCwds = new Set([...successCwds, ...failureCwds]);
    else inputCwds = pipelineBase;
    if (segment.separatorBefore !== "|") pipelineBase = new Set(inputCwds);

    const split = splitRedirections(segment.tokens);
    const assignmentPrefix = peelLeadingAssignments(split.argv);
    const wrapper = unwrap(
      assignmentPrefix.tokens,
      [...inheritedAssignments, ...assignmentPrefix.assignments],
      inheritedAssignmentEnvironmentSupported,
    );
    const commandSuccess = new Set<string>();
    const commandFailure = new Set(inputCwds);
    for (const cwdKey of inputCwds) {
      const { cwd: invocationCwd, uncertain: invocationCwdUncertain } = reachableCwdFromKey(cwdKey);
      const visibleAccesses = (accesses: BashAccess[]) => invocationCwdUncertain
        ? accesses.filter((access) => !cwdDependentAccesses.has(access))
        : accesses;
      if (wrapper.shellPayload) {
        const nested = analyzeBashInternal(
          wrapper.shellPayload.value,
          { workspaceRoot: invocationCwd },
          invocationCwdUncertain,
          wrapper.assignments,
          wrapper.assignmentEnvironmentSupported,
        );
        const outerRedirects = visibleAccesses(deriveAccesses("", [], split.redirects, invocationCwd).accesses);
        nestedBackground ||= nested.hasBackgroundOperator;
        nestedDynamic ||= assignmentPrefix.dynamic || nested.hasDynamicReferences;
        for (let nestedIndex = 0; nestedIndex < nested.invocations.length; nestedIndex += 1) {
          const nestedInvocation = nested.invocations[nestedIndex]!;
          invocations.push({
            ...nestedInvocation,
            dynamic: invocationCwdUncertain || assignmentPrefix.dynamic || nestedInvocation.dynamic,
            segmentIndex,
            separatorBefore: nestedIndex === 0 ? segment.separatorBefore : nestedInvocation.separatorBefore,
            accesses: uniqueAccesses([
              ...nestedInvocation.accesses,
              ...(nestedIndex === 0 ? outerRedirects : []),
            ]),
            privilege: wrapper.privilege || nestedInvocation.privilege,
            privilegeShapeSupported: wrapper.supported && nestedInvocation.privilegeShapeSupported,
            ...(nestedIndex === 0 && wrapper.shellCommand ? { shellWrapper: wrapper.shellCommand } : {}),
          });
        }
        commandSuccess.add(cwdKey);
        continue;
      }
      const tokens = wrapper.tokens;
      const executableValue = tokens[0]?.value ?? "";
      const commandName = executableValue.includes("/") ? executableValue : path.basename(executableValue);
      const derived = deriveAccesses(
        commandName,
        tokens,
        split.redirects,
        invocationCwd,
        wrapper.assignments,
        wrapper.assignmentEnvironmentSupported,
      );
      const derivedAccesses = visibleAccesses(derived.accesses);
      invocations.push({
        command: commandName,
        argv: tokens.map((token) => token.value),
        quoted: tokens.map((token) => token.quoted),
        literal: tokens.map((token) => token.literal),
        escaped: tokens.map((token) => token.escaped),
        unquotedPattern: tokens.map((token) => token.unquotedPattern),
        cwd: invocationCwd,
        segmentIndex,
        separatorBefore: segment.separatorBefore,
        accesses: uniqueAccesses(derivedAccesses),
        dynamic: invocationCwdUncertain || assignmentPrefix.dynamic || !derived.descriptorSupported
          || tokens.some((token) => !token.literal || (!token.quoted && !token.escaped && DYNAMIC_PATTERN.test(token.value) && !FIXED_VARIABLE.test(token.value))),
        privilege: wrapper.privilege,
        privilegeShapeSupported: wrapper.supported,
        ...(derived.remoteDestination ? { remoteDestination: true } : {}),
        ...(commandName === "git"
          ? {
              gitGlobalShapeSupported: derived.gitGlobalShapeSupported ?? false,
              ...(derived.gitSubcommandIndex !== undefined ? { gitSubcommandIndex: derived.gitSubcommandIndex } : {}),
              ...(derived.gitPathspecMode !== undefined ? { gitPathspecMode: derived.gitPathspecMode } : {}),
            }
          : {}),
        ...(["chmod", "chown"].includes(commandName)
          ? { recursive: derived.recursive, targetArgvIndexes: derived.targetArgvIndexes ?? [] }
          : {}),
        ...(commandName === "find"
          ? {
              targetOperation: findTargetOperation(tokens.slice(1)),
              targetArgvIndexes: findTargetFacts(tokens.slice(1)).targetIndexes.map((index) => index + 1),
            }
          : {}),
      });
      if (commandName === "cd") {
        const cdArgs = tokens.slice(1);
        const noTarget = cdArgs.length === 0 || (cdArgs.length === 1 && cdArgs[0]!.value === "--");
        const targetToken = noTarget ? undefined : positionals(cdArgs)[0];
        const target = noTarget
          ? homedir()
          : derived.descriptorSupported && targetToken && !(invocationCwdUncertain && tokenPathDependsOnCwd(targetToken))
            ? literalPath(targetToken, invocationCwd, true)
            : undefined;
        commandSuccess.add(reachableCwdKey(target
          ? { cwd: target, uncertain: false }
          : { cwd: invocationCwd, uncertain: true }));
      } else commandSuccess.add(cwdKey);
    }
    if (segment.separatorBefore === "|") {
      successCwds = pipelineBase;
      failureCwds = pipelineBase;
    } else if (segment.separatorBefore === "&&") {
      successCwds = commandSuccess;
      failureCwds = new Set([...priorFailure, ...commandFailure]);
    } else if (segment.separatorBefore === "||") {
      successCwds = new Set([...priorSuccess, ...commandSuccess]);
      failureCwds = commandFailure;
    } else {
      successCwds = commandSuccess;
      failureCwds = commandFailure;
    }
  }

  const accesses = uniqueAccesses(invocations.flatMap((invocation) => invocation.accesses));
  return {
    command,
    cwd,
    invocations,
    accesses,
    hasBackgroundOperator: scanned.background || nestedBackground,
    hasDynamicReferences: scanned.dynamic || nestedDynamic || invocations.some((invocation) => invocation.dynamic),
  };
}
