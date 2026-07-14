import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { errorHandler } from "../error-handler";
import { createDirectoriesRoutes, type DirectoriesRoutesOptions, type DirectoryEntry } from "./directories";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "directories-routes");

interface DirectoriesResponseBody {
  entries: DirectoryEntry[];
  truncated: boolean;
}

function createTestApp(options?: DirectoriesRoutesOptions): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/api/directories", createDirectoriesRoutes(options));
  return app;
}

async function createDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

async function readDirectories(res: Response): Promise<DirectoriesResponseBody> {
  return (await res.json()) as DirectoriesResponseBody;
}

describe("directories routes", () => {
  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("GET /api/directories/list returns one-level directories only", async () => {
    const root = await createDir(join(tempRoot, "list-success"));
    await createDir(join(root, "alpha"));
    await createDir(join(root, "beta"));
    await Bun.write(join(root, "file.txt"), "not a directory");
    const app = createTestApp();

    const res = await app.request(`/api/directories/list?path=${encodeURIComponent(root)}`);
    const body = await readDirectories(res);

    expect(res.status).toBe(200);
    expect(body).toEqual({
      entries: [
        { name: "alpha", path: join(root, "alpha") },
        { name: "beta", path: join(root, "beta") },
      ],
      truncated: false,
    });
  });

  test("GET /api/directories/list requires path", async () => {
    const app = createTestApp();

    const res = await app.request("/api/directories/list");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "path is required" },
    });
  });

  test("GET /api/directories/list returns empty for nonexistent path", async () => {
    const app = createTestApp();
    const missing = join(tempRoot, "missing");

    const res = await app.request(`/api/directories/list?path=${encodeURIComponent(missing)}`);

    expect(res.status).toBe(200);
    const body = await readDirectories(res);
    expect(body.entries).toEqual([]);
    expect(body.truncated).toBe(false);
  });

  test("GET /api/directories/list returns empty for file path", async () => {
    const filePath = join(tempRoot, "file-path.txt");
    await Bun.write(filePath, "content");
    const app = createTestApp();

    const res = await app.request(`/api/directories/list?path=${encodeURIComponent(filePath)}`);

    expect(res.status).toBe(200);
    const body = await readDirectories(res);
    expect(body.entries).toEqual([]);
    expect(body.truncated).toBe(false);
  });

  test("GET /api/directories/list filters by prefix when path does not exist", async () => {
    const root = await createDir(join(tempRoot, "prefix-filter"));
    await createDir(join(root, "alpha"));
    await createDir(join(root, "alpha-extra"));
    await createDir(join(root, "beta"));
    const app = createTestApp();

    const res = await app.request(`/api/directories/list?path=${encodeURIComponent(join(root, "alp"))}`);

    expect(res.status).toBe(200);
    const body = await readDirectories(res);
    expect(body.entries.map((e) => e.name)).toEqual(["alpha", "alpha-extra"]);
  });

  test("GET /api/directories/list caps limit at 100 and marks truncated", async () => {
    const root = await createDir(join(tempRoot, "limit-cap"));
    for (let index = 0; index < 105; index += 1) {
      await createDir(join(root, `dir-${String(index).padStart(3, "0")}`));
    }
    const app = createTestApp();

    const res = await app.request(`/api/directories/list?path=${encodeURIComponent(root)}&limit=999`);
    const body = await readDirectories(res);

    expect(res.status).toBe(200);
    expect(body.entries).toHaveLength(100);
    expect(body.truncated).toBe(true);
    expect(body.entries.every((entry) => Object.keys(entry).sort().join(",") === "name,path")).toBe(true);
  });

  test("GET /api/directories/list rejects a non-positive or non-integer limit", async () => {
    const root = await createDir(join(tempRoot, "invalid-list-limit"));
    const app = createTestApp();

    for (const limit of ["0", "-1", "1.5", "not-a-number"]) {
      const res = await app.request(`/api/directories/list?path=${encodeURIComponent(root)}&limit=${limit}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: "BAD_REQUEST", message: "limit must be a positive integer" },
      });
    }
  });

  test("GET /api/directories/list sorts visible directories before hidden directories", async () => {
    const root = await createDir(join(tempRoot, "hidden-sort"));
    for (const name of ["zeta", ".z-hidden", "alpha", ".a-hidden"]) {
      await createDir(join(root, name));
    }
    const app = createTestApp();

    const res = await app.request(`/api/directories/list?path=${encodeURIComponent(root)}`);
    const body = await readDirectories(res);

    expect(res.status).toBe(200);
    expect(body.entries.map((entry) => entry.name)).toEqual(["alpha", "zeta", ".a-hidden", ".z-hidden"]);
  });

  test("GET /api/directories/list skips unreadable entries where platform enforces permissions", async () => {
    const root = await createDir(join(tempRoot, "permission-skip"));
    const readable = await createDir(join(root, "readable"));
    const unreadable = await createDir(join(root, "unreadable"));
    await chmod(unreadable, 0o000);
    const app = createTestApp();

    try {
      const probe = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: unreadable, onlyFiles: false })).catch(() => undefined);
      const res = await app.request(`/api/directories/list?path=${encodeURIComponent(root)}`);
      const body = await readDirectories(res);

      expect(res.status).toBe(200);
      if (probe === undefined) {
        expect(body.entries).toEqual([{ name: "readable", path: readable }]);
      } else {
        expect(body.entries.map((entry) => entry.name)).toContain("readable");
      }
    } finally {
      await chmod(unreadable, 0o700).catch(() => undefined);
    }
  });

  test("GET /api/directories/search requires query", async () => {
    const app = createTestApp({ roots: [tempRoot] });

    const res = await app.request("/api/directories/search");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "query is required" },
    });
  });

  test("GET /api/directories/search rejects empty query", async () => {
    const app = createTestApp({ roots: [tempRoot] });

    const res = await app.request("/api/directories/search?query=%20%20");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "query must not be empty" },
    });
  });

  test("GET /api/directories/search rejects an invalid limit", async () => {
    const app = createTestApp({ roots: [tempRoot] });

    const res = await app.request("/api/directories/search?query=project&limit=invalid");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "limit must be a positive integer" },
    });
  });

  test("GET /api/directories/search ranks matches, caps result limit, and skips heavy directories", async () => {
    const root = await createDir(join(tempRoot, "search-basic"));
    await createDir(join(root, "project-alpha"));
    await createDir(join(root, "project-beta"));
    await createDir(join(root, "notes"));
    await createDir(join(root, "node_modules", "project-hidden"));
    await createDir(join(root, ".git", "project-secret"));
    const app = createTestApp({ roots: [root] });

    const res = await app.request("/api/directories/search?query=project&limit=1");
    const body = await readDirectories(res);

    expect(res.status).toBe(200);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.name).toContain("project");
    expect(body.entries.map((entry) => entry.path).join("\n")).not.toContain("node_modules");
    expect(body.entries.map((entry) => entry.path).join("\n")).not.toContain(".git");
    expect(body.truncated).toBe(true);
  });

  test("GET /api/directories/search uses bounded traversal and returns within time budget", async () => {
    const root = await createDir(join(tempRoot, "bounded"));
    let parent = root;
    for (let depth = 0; depth < 8; depth += 1) {
      parent = await createDir(join(parent, `level-${depth}`));
    }
    await createDir(join(root, "match-near-root"));
    await createDir(join(parent, "match-too-deep"));
    const app = createTestApp({ roots: [root], maxDepth: 5, maxVisited: 20, timeBudgetMs: 1500 });

    const started = performance.now();
    const res = await app.request("/api/directories/search?query=match&limit=10");
    const elapsed = performance.now() - started;
    const body = await readDirectories(res);

    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(1500);
    expect(body.entries.map((entry) => entry.name)).toContain("match-near-root");
    expect(body.entries.map((entry) => entry.name)).not.toContain("match-too-deep");
  });

  test("GET /api/directories/search skips unreadable directories without returning 500", async () => {
    const root = await createDir(join(tempRoot, "unreadable-search"));
    await createDir(join(root, "needle-visible"));
    const unreadable = await createDir(join(root, "blocked"));
    await createDir(join(unreadable, "needle-hidden"));
    await chmod(unreadable, 0o000);
    const app = createTestApp({ roots: [root] });

    try {
      const res = await app.request("/api/directories/search?query=needle&limit=10");
      const body = await readDirectories(res);

      expect(res.status).toBe(200);
      expect(body.entries.map((entry) => entry.name)).toContain("needle-visible");
    } finally {
      await chmod(unreadable, 0o700).catch(() => undefined);
    }
  });
});
