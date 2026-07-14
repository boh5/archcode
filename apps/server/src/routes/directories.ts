import fuzzysort from "fuzzysort";
import { Hono } from "hono";
import { z } from "zod/v4";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { zValidator } from "../validation";

export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface DirectoriesResponse {
  entries: DirectoryEntry[];
  truncated: boolean;
}

export interface DirectoriesRoutesOptions {
  roots?: string[];
  maxVisited?: number;
  maxDepth?: number;
  timeBudgetMs?: number;
}

interface SearchCandidate extends DirectoryEntry {
  target: string;
}

interface SearchQueueItem {
  path: string;
  depth: number;
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_MAX_VISITED = 2_000;
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_TIME_BUDGET_MS = 1_500;
const SKIPPED_EXACT_NAMES = new Set(["node_modules", ".git", "dist", "build", "target", "vendor", ".Trash"]);

const PositiveLimitQueryValueSchema = z.string().optional().transform((value, context) => {
  if (value === undefined || value.length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    context.addIssue({ code: "custom", message: "limit must be a positive integer" });
    return z.NEVER;
  }
  return parsed;
});

const ListDirectoriesQuerySchema = z.object({
  path: z.string({ error: "path is required" }).min(1, "path is required"),
  limit: PositiveLimitQueryValueSchema.transform((value) => Math.min(value ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT)),
}).strict();

const SearchDirectoriesQuerySchema = z.object({
  query: z.string({ error: "query is required" })
    .min(1, "query is required")
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, "query must not be empty"),
  limit: PositiveLimitQueryValueSchema.transform((value) => Math.min(value ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)),
}).strict();

export function createDirectoriesRoutes(options: DirectoriesRoutesOptions = {}): Hono {
  const app = new Hono();

  app.get("/list", zValidator("query", ListDirectoriesQuerySchema), async (c) => {
    const { path, limit } = c.req.valid("query");
    const resolved = resolvePath(path);
    const rootStat = await safeStat(resolved);

    if (rootStat?.isDirectory()) {
      const entries = await listDirectories(resolved);
      const sorted = entries.sort(compareDirectoryEntries);
      return c.json({ entries: sorted.slice(0, limit), truncated: sorted.length > limit } satisfies DirectoriesResponse);
    }

    // Path doesn't resolve to a directory — treat the last segment as a prefix filter on the parent.
    // e.g. "~/D" resolves to "/Users/bo/D" which doesn't exist → list "/Users/bo" children starting with "D"
    const parent = dirname(resolved);
    const prefix = basename(resolved);
    const parentStat = await safeStat(parent);

    if (!parentStat?.isDirectory()) {
      return c.json({ entries: [], truncated: false } satisfies DirectoriesResponse);
    }

    const entries = await listDirectories(parent);
    const filtered = prefix.length > 0
      ? entries.filter((e) => e.name.toLowerCase().startsWith(prefix.toLowerCase()))
      : entries;
    const sorted = filtered.sort(compareDirectoryEntries);
    return c.json({ entries: sorted.slice(0, limit), truncated: sorted.length > limit } satisfies DirectoriesResponse);
  });

  app.get("/search", zValidator("query", SearchDirectoriesQuerySchema), async (c) => {
    const { query, limit } = c.req.valid("query");
    const candidates = await collectSearchCandidates({
      roots: await resolveSearchRoots(options.roots),
      maxVisited: options.maxVisited ?? DEFAULT_MAX_VISITED,
      maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
      timeBudgetMs: options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS,
    });
    const ranked = fuzzysort.go(query, candidates, { key: "target", all: false, limit: limit + 1 });
    const entries = ranked.slice(0, limit).map((result) => toDirectoryEntry(result.obj));

    return c.json({ entries, truncated: ranked.length > limit } satisfies DirectoriesResponse);
  });

  return app;
}

async function listDirectories(root: string): Promise<DirectoryEntry[]> {
  const dirents = await safeReadDir(root);
  if (!dirents) return [];

  const entries: DirectoryEntry[] = [];
  for (const dirent of dirents) {
    const childPath = join(root, dirent.name);
    const childStat = await safeStat(childPath);
    if (!childStat?.isDirectory()) continue;
    if (!(await canReadDirectory(childPath))) continue;
    entries.push({ name: dirent.name, path: childPath });
  }

  return entries;
}

async function collectSearchCandidates(options: {
  roots: string[];
  maxVisited: number;
  maxDepth: number;
  timeBudgetMs: number;
}): Promise<SearchCandidate[]> {
  const started = performance.now();
  const queue: SearchQueueItem[] = options.roots.map((path) => ({ path, depth: 0 }));
  const seen = new Set<string>();
  const candidates: SearchCandidate[] = [];
  let visited = 0;

  while (queue.length > 0 && visited < options.maxVisited && performance.now() - started < options.timeBudgetMs) {
    const item = queue.shift();
    if (!item || seen.has(item.path) || shouldSkipPath(item.path)) continue;
    seen.add(item.path);

    const itemStat = await safeStat(item.path);
    if (!itemStat?.isDirectory()) continue;
    if (!(await canReadDirectory(item.path))) continue;

    visited += 1;
    candidates.push(toSearchCandidate(item.path));

    if (item.depth >= options.maxDepth) continue;

    const children = await safeReadDir(item.path);
    if (!children) continue;

    for (const child of children) {
      if (!child.isDirectory() || shouldSkipName(child.name)) continue;
      queue.push({ path: join(item.path, child.name), depth: item.depth + 1 });
    }
  }

  return candidates;
}

async function resolveSearchRoots(roots?: string[]): Promise<string[]> {
  const candidates = roots ?? [homedir(), "/Users", "/Volumes", "/"];
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const root = resolvePath(candidate);
    if (seen.has(root) || shouldSkipPath(root)) continue;
    seen.add(root);
    const rootStat = await safeStat(root);
    if (!rootStat?.isDirectory()) continue;
    if (!(await canReadDirectory(root))) continue;
    deduped.push(root);
  }

  return deduped;
}

function toSearchCandidate(path: string): SearchCandidate {
  return { ...toDirectoryEntry({ name: basename(path) || path, path }), target: `${basename(path)} ${path}` };
}

function toDirectoryEntry(entry: DirectoryEntry): DirectoryEntry {
  return { name: entry.name, path: entry.path };
}

function compareDirectoryEntries(left: DirectoryEntry, right: DirectoryEntry): number {
  const leftHidden = left.name.startsWith(".");
  const rightHidden = right.name.startsWith(".");
  if (leftHidden !== rightHidden) return leftHidden ? 1 : -1;
  return left.name.localeCompare(right.name);
}

function resolvePath(path: string): string {
  const expanded = path === "~" || path.startsWith("~/")
    ? join(homedir(), path === "~" ? "" : path.slice(2))
    : path.startsWith("~")
      ? join(homedir(), path.slice(1))
      : path;
  return resolve(expanded);
}

async function safeReadDir(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

async function safeStat(path: string) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

async function canReadDirectory(path: string): Promise<boolean> {
  const entries = await safeReadDir(path);
  return entries !== undefined;
}

function shouldSkipPath(path: string): boolean {
  return path.includes("/Library/Caches/") || path.endsWith("/Library/Caches");
}

function shouldSkipName(name: string): boolean {
  return SKIPPED_EXACT_NAMES.has(name);
}
