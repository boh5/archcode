import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { PathValidator, resolveAndValidatePath } from "./path-validator";

let testDir: string;
let workspaceDir: string;
let outsideDir: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "path-validator-"));
  workspaceDir = join(testDir, "workspace");
  outsideDir = join(testDir, "outside");
  mkdirSync(join(workspaceDir, "src"), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(workspaceDir, "src", "main.ts"), "export {};\n", "utf8");
  writeFileSync(join(outsideDir, "secret.txt"), "secret\n", "utf8");
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("PathValidator", () => {
  test("allows relative paths inside workspace", () => {
    const validator = new PathValidator(workspaceDir);
    const result = validator.validate("src/main.ts");

    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(
      realpathSync.native(join(workspaceDir, "src", "main.ts")),
    );
    expect(result.error).toBeUndefined();
  });

  test("allows absolute paths inside workspace", () => {
    const absolutePath = join(workspaceDir, "src", "main.ts");
    const result = new PathValidator(workspaceDir).validate(absolutePath);

    expect(result.ok).toBe(true);
    expect(result.absolutePath).toBe(path.resolve(absolutePath));
    expect(result.resolvedPath).toBe(realpathSync.native(absolutePath));
  });

  test("allows normalization that remains inside workspace", () => {
    const validator = new PathValidator(workspaceDir);
    const normalized = validator.validate("src/../src/main.ts");
    const direct = validator.validate("src/main.ts");

    expect(normalized.ok).toBe(true);
    expect(normalized.resolvedPath).toBe(direct.resolvedPath);
  });

  test("denies parent traversal outside workspace", () => {
    const result = new PathValidator(workspaceDir).validate("../outside/secret.txt");

    expect(result.ok).toBe(false);
    expect(result.resolvedPath).toBe(realpathSync.native(join(outsideDir, "secret.txt")));
    expect(result.error).toEqual({
      code: "PATH_OUTSIDE_WORKSPACE",
      inputPath: "../outside/secret.txt",
      absolutePath: path.resolve(workspaceDir, "../outside/secret.txt"),
      resolvedPath: realpathSync.native(join(outsideDir, "secret.txt")),
      workspaceRoot: path.resolve(workspaceDir),
      workspaceRealPath: realpathSync.native(workspaceDir),
    });
  });

  test("denies symlink escapes outside workspace", () => {
    const linkPath = join(workspaceDir, "outside-link");
    try {
      symlinkSync(outsideDir, linkPath, "dir");
    } catch {
      // The symlink may already exist if the test is retried in-process.
    }

    const result = new PathValidator(workspaceDir).validate("outside-link/secret.txt");

    expect(result.ok).toBe(false);
    expect(result.resolvedPath).toBe(realpathSync.native(join(outsideDir, "secret.txt")));
    expect(result.error?.code).toBe("PATH_OUTSIDE_WORKSPACE");
  });

  test("allows nonexistent paths whose nearest existing ancestor is inside", () => {
    const result = new PathValidator(workspaceDir).validate("src/new/deep/file.ts");

    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(
      join(realpathSync.native(join(workspaceDir, "src")), "new", "deep", "file.ts"),
    );
  });

  test("denies nonexistent paths whose nearest existing ancestor is outside", () => {
    const result = new PathValidator(workspaceDir).validate(
      "../outside/missing/deep/file.ts",
    );

    expect(result.ok).toBe(false);
    expect(result.resolvedPath).toBe(
      join(realpathSync.native(outsideDir), "missing", "deep", "file.ts"),
    );
    expect(result.error).toEqual({
      code: "PATH_OUTSIDE_WORKSPACE",
      inputPath: "../outside/missing/deep/file.ts",
      absolutePath: path.resolve(workspaceDir, "../outside/missing/deep/file.ts"),
      resolvedPath: join(realpathSync.native(outsideDir), "missing", "deep", "file.ts"),
      workspaceRoot: path.resolve(workspaceDir),
      workspaceRealPath: realpathSync.native(workspaceDir),
    });
  });

  test("resolveAndValidatePath exposes the canonical path result", () => {
    expect(resolveAndValidatePath("src/../src/main.ts", workspaceDir)).toEqual({
      resolved: realpathSync.native(join(workspaceDir, "src", "main.ts")),
      isWithinWorkspace: true,
    });
  });
});
