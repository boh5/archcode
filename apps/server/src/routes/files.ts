import { Hono } from "hono";
import { resolve } from "node:path";
import {
  createProcessRunner,
  detectVersionControl,
  InvalidSessionCwdError,
  resolveValidSessionCwd,
  SessionFileNotFoundError,
  type AgentRuntime,
} from "@archcode/agent-core";
import { z } from "zod/v4";
import { ServerError, SessionNotFoundError } from "../errors";
import { resolveProject } from "../resolve";
import { zValidator } from "../validation";

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
const processRunner = createProcessRunner();
const DiffParamsSchema = z.strictObject({ slug: z.string().min(1) });
const DiffQuerySchema = z.strictObject({
  sessionId: z.string().trim().min(1, "sessionId must not be empty").optional(),
});

export function createFilesRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/:slug/diff", zValidator("param", DiffParamsSchema), zValidator("query", DiffQuerySchema), async (c) => {
    const { slug } = c.req.valid("param");
    const { sessionId } = c.req.valid("query");
    const project = await resolveProject(runtime, slug);
    const cwd = await resolveDiffCwd(runtime, project.workspaceRoot, sessionId);

    if (await detectVersionControl(cwd) !== "git") {
      return c.json({ files: [] });
    }

    const [rawDiff, untrackedPaths] = await Promise.all([
      runGit(cwd, [
        "diff",
        "HEAD",
        "--no-color",
        "--unified=3",
        "--no-ext-diff",
        "--no-renames",
      ]),
      runGit(cwd, ["ls-files", "--others", "--exclude-standard"]),
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

async function resolveDiffCwd(
  runtime: AgentRuntime,
  projectRoot: string,
  sessionId: string | undefined,
): Promise<string> {
  if (sessionId === undefined) return projectRoot;

  let session: Awaited<ReturnType<AgentRuntime["getSessionFile"]>>;
  try {
    session = await runtime.getSessionFile(projectRoot, sessionId);
  } catch (error) {
    if (error instanceof SessionFileNotFoundError || isMissingFileError(error)) {
      throw new SessionNotFoundError(sessionId);
    }
    throw error;
  }

  const persistedCwd = session.cwd;
  if (resolve(persistedCwd) === resolve(projectRoot)) return projectRoot;

  try {
    const worktree = await resolveValidSessionCwd(projectRoot, persistedCwd);
    if (worktree === undefined) {
      throw new InvalidSessionCwdError(persistedCwd, "must resolve to a linked worktree");
    }
    return worktree.path;
  } catch (error) {
    if (error instanceof InvalidSessionCwdError) {
      throw new ServerError(
        "SESSION_CWD_INVALID",
        `Session ${sessionId} does not have a valid worktree execution directory`,
        409,
      );
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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

async function runGit(workspaceRoot: string, args: string[]): Promise<string> {
  const result = await processRunner.run(runGitInput(workspaceRoot, args));

  switch (result.kind) {
    case "success":
      return result.output.stdout;
    case "nonzero":
      throw new ServerError("INTERNAL_ERROR", `Git command failed: ${result.output.stderr.trim()}`, 500);
    case "timeout":
      throw new ServerError("INTERNAL_ERROR", `Git command timed out after ${result.timeoutMs}ms`, 500);
    case "aborted":
      throw new ServerError("INTERNAL_ERROR", "Git command was aborted", 500);
    case "signal":
      throw new ServerError("INTERNAL_ERROR", `Git command was terminated by signal ${result.signal}`, 500);
    case "spawn-failure":
      throw new ServerError("INTERNAL_ERROR", `Git command failed: ${result.error.message}`, 500);
  }
}

function runGitInput(workspaceRoot: string, args: string[]): Parameters<typeof processRunner.run>[0] {
  return {
    argv: ["git", ...args],
    cwd: workspaceRoot,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  };
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
