import { z } from "zod";

// ─── Types ───

export interface SearchArgs {
  pattern: string;
  path?: string;
  include?: string;
  outputMode?: "content" | "files_with_matches" | "count";
  context?: number;
}

export interface FileArgs {
  pattern?: string;
  path?: string;
  sortBy?: "modified" | "path";
}

export interface MatchLine {
  lineNumber: number;
  content: string;
}

export interface MatchResult {
  type: "match";
  path: string;
  lineNumber: number;
  content: string;
}

export interface SearchResult {
  matches: MatchResult[];
  totalMatches: number;
  truncated: boolean;
}

// ─── Zod Schemas ───

export const SearchArgsSchema = z
  .object({
    pattern: z.string(),
    path: z.string().optional(),
    include: z.string().optional(),
    outputMode: z.enum(["content", "files_with_matches", "count"]).default("content"),
    context: z.number().int().nonnegative().default(0),
  })
  .strict();

export const FileArgsSchema = z
  .object({
    pattern: z.string().optional(),
    path: z.string().optional(),
    sortBy: z.enum(["modified", "path"]).default("modified"),
  })
  .strict();

// ─── NDJSON Parsing ───

interface RgMatchData {
  path?: { text: string };
  lines?: { text: string };
  line_number?: number;
}

interface RgJsonLine {
  type: string;
  data?: RgMatchData;
}

/**
 * Parse a single rg --json NDJSON line.
 * Returns a MatchResult for type="match" lines, null for everything else.
 */
export function parseRgJsonLine(line: string): MatchResult | null {
  if (!line) return null;

  let parsed: RgJsonLine;
  try {
    parsed = JSON.parse(line) as RgJsonLine;
  } catch {
    return null;
  }

  if (parsed.type !== "match" || !parsed.data) {
    return null;
  }

  const { data } = parsed;
  const path = data.path?.text ?? "";
  const lineNumber = data.line_number ?? 0;
  let content = data.lines?.text ?? "";
  // rg appends trailing newline (\n or \r\n) to lines.text
  content = content.replace(/\r?\n$/, "");

  return { type: "match", path, lineNumber, content };
}

/**
 * Parse full rg --json NDJSON output into a SearchResult.
 * maxResults defaults to 100.
 */
export function parseRgOutput(rawOutput: string, maxResults: number = 100): SearchResult {
  const matches: MatchResult[] = [];
  let totalMatches = 0;

  const lines = rawOutput.split("\n");
  for (const line of lines) {
    const match = parseRgJsonLine(line);
    if (match !== null) {
      totalMatches++;
      if (matches.length < maxResults) {
        matches.push(match);
      }
    }
  }

  return {
    matches,
    totalMatches,
    truncated: totalMatches > maxResults,
  };
}

/**
 * Format SearchResult into human-readable output.
 * outputMode controls format:
 *   "content"            → path:line:content
 *   "files_with_matches" → unique paths (sorted)
 *   "count"              → path:count per file (sorted)
 */
export function formatSearchResult(
  result: SearchResult,
  outputMode: "content" | "files_with_matches" | "count" = "content",
): string {
  if (result.matches.length === 0) return "";

  switch (outputMode) {
    case "content":
      return result.matches
        .map((m) => `${m.path}:${m.lineNumber}:${m.content}`)
        .join("\n");

    case "files_with_matches": {
      const uniquePaths = [...new Set(result.matches.map((m) => m.path))].sort();
      return uniquePaths.join("\n");
    }

    case "count": {
      const counts = new Map<string, number>();
      for (const m of result.matches) {
        counts.set(m.path, (counts.get(m.path) ?? 0) + 1);
      }
      const entries = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      return entries.map(([path, count]) => `${path}:${count}`).join("\n");
    }
  }
}

/**
 * Build rg command-line arguments for files-with-matches (list matching files).
 * Uses --files-with-matches for accurate file listing without match truncation.
 */
export function buildFileListArgs(pattern: string, include?: string, path?: string): string[] {
  const cmdArgs: string[] = ["--files-with-matches", "-e", pattern];
  if (include) {
    cmdArgs.push("--glob", include);
  }
  if (path) {
    cmdArgs.push(path);
  }
  return cmdArgs;
}

/**
 * Build rg command-line arguments for count mode.
 * Uses --count for accurate per-file match counts without truncation.
 */
export function buildCountArgs(pattern: string, include?: string, path?: string): string[] {
  const cmdArgs: string[] = ["--count", "-e", pattern];
  if (include) {
    cmdArgs.push("--glob", include);
  }
  if (path) {
    cmdArgs.push(path);
  }
  return cmdArgs;
}

/**
 * Build rg command-line arguments for content (--json) mode.
 * Only handles content mode; use buildFileListArgs / buildCountArgs for other modes.
 */
export function buildSearchArgs(args: SearchArgs, _rgPath: string): string[] {
  const cmdArgs: string[] = [];

  cmdArgs.push("--json");
  cmdArgs.push("-e", args.pattern);
  cmdArgs.push("--max-count", "100");

  if (args.include) {
    cmdArgs.push("--glob", args.include);
  }
  if (args.context && args.context > 0) {
    cmdArgs.push("--context", String(args.context));
  }
  if (args.path) {
    cmdArgs.push(args.path);
  }

  return cmdArgs;
}
