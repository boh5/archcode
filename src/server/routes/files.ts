import { Hono } from "hono";
import type { SpecraRuntime } from "@specra/agent-core";
import { BadRequestError, ServerError } from "../errors";
import { resolveProject } from "../resolve";

export type DiffLineType = "context" | "add" | "delete";

export interface DiffLine {
  type: DiffLineType;
  content: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  status: "modified" | "created" | "deleted";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function createFilesRoutes(runtime: SpecraRuntime): Hono {
  const app = new Hono();

  app.get("/:slug/diff", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const [rawDiff, untrackedPaths] = await Promise.all([
      runGit(project.workspaceRoot, [
        "diff",
        "HEAD",
        "--no-color",
        "--unified=3",
        "--no-ext-diff",
        "--no-renames",
      ]),
      runGit(project.workspaceRoot, ["ls-files", "--others", "--exclude-standard"]),
    ]);

    const files = parseUnifiedDiff(rawDiff);
    const trackedPaths = new Set(files.map((file) => file.path));
    for (const path of parsePathList(untrackedPaths)) {
      if (!trackedPaths.has(path)) {
        files.push({ path, status: "created", additions: 0, deletions: 0, hunks: [] });
      }
    }

    return c.json({ files });
  });

  return app;
}

export function parseUnifiedDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let currentFile: DiffFile | undefined;
  let currentHunk: DiffHunk | undefined;
  let pendingStatus: DiffFile["status"] = "modified";

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      currentFile = createDiffFile(pathFromDiffGitLine(line));
      currentHunk = undefined;
      pendingStatus = "modified";
      files.push(currentFile);
      continue;
    }

    if (!currentFile) continue;

    if (line === "new file mode" || line.startsWith("new file mode ")) {
      pendingStatus = "created";
      currentFile.status = "created";
      continue;
    }

    if (line === "deleted file mode" || line.startsWith("deleted file mode ")) {
      pendingStatus = "deleted";
      currentFile.status = "deleted";
      continue;
    }

    if (line.startsWith("--- ")) {
      const oldPath = parseHeaderPath(line.slice(4));
      if (oldPath === undefined) {
        currentFile.status = "created";
      } else if (pendingStatus !== "created") {
        currentFile.path = oldPath;
      }
      continue;
    }

    if (line.startsWith("+++ ")) {
      const newPath = parseHeaderPath(line.slice(4));
      if (newPath === undefined) {
        currentFile.status = "deleted";
      } else {
        currentFile.path = newPath;
        if (pendingStatus === "created") currentFile.status = "created";
      }
      continue;
    }

    if (line.startsWith("@@ ")) {
      const hunk = parseHunkHeader(line);
      if (!hunk) continue;
      currentHunk = hunk;
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({ type: "add", content: line.slice(1) });
      currentFile.additions += 1;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ type: "delete", content: line.slice(1) });
      currentFile.deletions += 1;
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({ type: "context", content: line.slice(1) });
    }
  }

  return files.filter((file) => file.path.length > 0);
}

function requiredParam(value: string | undefined, name: string): string {
  if (!value) {
    throw new BadRequestError(`${name} is required`);
  }

  return value;
}

async function runGit(workspaceRoot: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: workspaceRoot,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new ServerError("INTERNAL_ERROR", `Git command failed: ${stderr.trim()}`, 500);
  }

  return stdout;
}

function createDiffFile(path: string): DiffFile {
  return { path, status: "modified", additions: 0, deletions: 0, hunks: [] };
}

function parseHunkHeader(line: string): DiffHunk | undefined {
  const match = HUNK_HEADER_PATTERN.exec(line);
  if (!match) return undefined;

  return {
    header: line,
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
    lines: [],
  };
}

function pathFromDiffGitLine(line: string): string {
  const parts = line.slice("diff --git ".length).split(" ");
  const candidate = parts[1] ?? parts[0] ?? "";
  return stripGitPrefix(candidate);
}

function parseHeaderPath(value: string): string | undefined {
  const [path] = value.split("\t");
  if (path === "/dev/null") return undefined;
  return stripGitPrefix(path ?? "");
}

function stripGitPrefix(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

function parsePathList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
}
