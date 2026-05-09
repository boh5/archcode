import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { exists, mkdir, rm } from "node:fs/promises";
import { getSessionsDir } from "./sessions-dir";

const TMP_DIR = join(import.meta.dir, "__test_tmp__");
const ENV_KEY = "SPECRA_SESSIONS_DIR";
const OLD_ENV = process.env;

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
  process.env = { ...OLD_ENV };
  delete process.env[ENV_KEY];
});

describe("getSessionsDir", () => {
  test("returns default ~/.specra/sessions/ when no override or env var", () => {
    const result = getSessionsDir();
    expect(result).toBe(join(homedir(), ".specra", "sessions"));
  });

  test("returns override path when provided (ignores env var)", () => {
    process.env[ENV_KEY] = "/tmp/env-override";
    const override = join(TMP_DIR, "custom-sessions");
    const result = getSessionsDir(override);
    expect(result).toBe(override);
  });

  test("returns SPECRA_SESSIONS_DIR env var when set and no override", () => {
    const envPath = join(TMP_DIR, "env-sessions");
    process.env[ENV_KEY] = envPath;
    const result = getSessionsDir();
    expect(result).toBe(envPath);
  });

  test("does NOT create the directory (pure path resolver)", async () => {
    const nonexistentPath = join(TMP_DIR, "should-not-exist", "deep", "path");
    const result = getSessionsDir(nonexistentPath);
    expect(result).toBe(nonexistentPath);
    expect(await exists(nonexistentPath)).toBe(false);
  });

  test("override path is not required to exist either", async () => {
    const override = join(TMP_DIR, "nonexistent", "deep", "path");
    const result = getSessionsDir(override);
    expect(result).toBe(override);
    expect(await exists(result)).toBe(false);
  });

  test("returns empty-string env var value as-is", () => {
    process.env[ENV_KEY] = "";
    const result = getSessionsDir();
    expect(result).toBe("");
  });

  test("relies on os.homedir() not process.env.HOME for default path", () => {
    const result = getSessionsDir();
    expect(result).toBe(join(homedir(), ".specra", "sessions"));
  });
});
