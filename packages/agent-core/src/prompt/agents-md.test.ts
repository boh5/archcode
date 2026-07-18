import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findAgentsMd, loadAgentsMd, AgentsMdLoadError } from "./agents-md";

const TMP = join(tmpdir(), `archcode-agents-md-test-${crypto.randomUUID()}`);

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
});

describe("findAgentsMd", () => {
  test("finds AGENTS.md in start directory", async () => {
    const dir = join(TMP, "find-direct");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "AGENTS.md"), "# Direct");

    const result = await findAgentsMd(dir);
    expect(result).toBe(join(dir, "AGENTS.md"));
  });

  test("finds AGENTS.md in parent directory", async () => {
    const parent = join(TMP, "find-parent");
    const child = join(parent, "child");
    await mkdir(child, { recursive: true });
    await Bun.write(join(parent, "AGENTS.md"), "# Parent");

    const result = await findAgentsMd(child);
    expect(result).toBe(join(parent, "AGENTS.md"));
  });

  test("finds AGENTS.md in grandparent directory", async () => {
    const gp = join(TMP, "find-gp");
    const parent = join(gp, "mid");
    const child = join(parent, "deep");
    await mkdir(child, { recursive: true });
    await Bun.write(join(gp, "AGENTS.md"), "# Grandparent");

    const result = await findAgentsMd(child);
    expect(result).toBe(join(gp, "AGENTS.md"));
  });

  test("returns undefined when no AGENTS.md found (isolated tmp)", async () => {
    const dir = join(TMP, "find-none", "isolated", "deep");
    await mkdir(dir, { recursive: true });

    const result = await findAgentsMd(dir);
    expect(result).toBeUndefined();
  });

  test("resolves relative startDir to absolute path", async () => {
    const dir = join(TMP, "find-relative");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "AGENTS.md"), "# Relative");

    const result = await findAgentsMd(dir);
    expect(result).toBeDefined();
    expect(result!.startsWith("/")).toBe(true);
  });
});

describe("loadAgentsMd", () => {
  test("loads AGENTS.md content", async () => {
    const dir = join(TMP, "load-content");
    await mkdir(dir, { recursive: true });
    const content = "# Loaded\n\nHello world";
    await Bun.write(join(dir, "AGENTS.md"), content);

    const result = await loadAgentsMd(dir);
    expect(result).toEqual({ path: join(dir, "AGENTS.md"), content });
  });

  test("returns undefined when no AGENTS.md found (isolated tmp)", async () => {
    const dir = join(TMP, "load-none", "isolated");
    await mkdir(dir, { recursive: true });

    const result = await loadAgentsMd(dir);
    expect(result).toBeUndefined();
  });

  test("finds AGENTS.md in parent directory", async () => {
    const parent = join(TMP, "load-parent");
    const child = join(parent, "sub");
    await mkdir(child, { recursive: true });
    await Bun.write(join(parent, "AGENTS.md"), "# Parent content");

    const result = await loadAgentsMd(child);
    expect(result).toEqual({ path: join(parent, "AGENTS.md"), content: "# Parent content" });
  });

  test("returns empty string content when AGENTS.md is empty", async () => {
    const dir = join(TMP, "load-empty");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "AGENTS.md"), "");

    const result = await loadAgentsMd(dir);
    expect(result).toEqual({ path: join(dir, "AGENTS.md"), content: "" });
  });
});

describe("AgentsMdLoadError", () => {
  test("has correct name and message", () => {
    const err = new AgentsMdLoadError("read failed", "/path/to/AGENTS.md");
    expect(err.name).toBe("AgentsMdLoadError");
    expect(err.message).toContain("read failed");
    expect(err.filePath).toBe("/path/to/AGENTS.md");
  });

  test("preserves cause", () => {
    const cause = new Error("original");
    const err = new AgentsMdLoadError("read failed", "/path/AGENTS.md", { cause });
    expect(err.cause).toBe(cause);
  });
});
