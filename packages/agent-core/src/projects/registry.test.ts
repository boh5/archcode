import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { ProjectRegistry, ProjectRegistryError } from "./registry";
import { createInMemoryLogger, silentLogger } from "../logger";

let tmpHome: string;
let tmpWorkspaceA: string;
let tmpWorkspaceB: string;
let tmpWorkspaceC: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "archcode-registry-"));
  tmpWorkspaceA = await mkdtemp(join(tmpdir(), "archcode-ws-a-"));
  tmpWorkspaceB = await mkdtemp(join(tmpdir(), "archcode-ws-b-"));
  tmpWorkspaceC = await mkdtemp(join(tmpdir(), "archcode-ws-c-"));
});

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
  await rm(tmpWorkspaceA, { recursive: true, force: true });
  await rm(tmpWorkspaceB, { recursive: true, force: true });
  await rm(tmpWorkspaceC, { recursive: true, force: true });
});

async function delay(ms = 5): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ProjectRegistry", () => {
  test("add creates new entry with slug, addedAt, and ProjectInfo shape", async () => {
    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });

    const project = await registry.add({ workspaceRoot: tmpWorkspaceA, name: "My API" });

    expect(project).toEqual({
      slug: "my-api",
      name: "My API",
      workspaceRoot: tmpWorkspaceA,
      addedAt: expect.any(String),
    });
    expect(project.lastOpenedAt).toBeUndefined();
    expect(new Date(project.addedAt).toString()).not.toBe("Invalid Date");
  });

  test("add is idempotent for the same workspaceRoot", async () => {
    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });

    const first = await registry.add({ workspaceRoot: tmpWorkspaceA, name: "Original" });
    const second = await registry.add({ workspaceRoot: tmpWorkspaceA, name: "Renamed" });

    expect(second).toEqual(first);
    expect((await registry.list()).map((project) => project.slug)).toEqual([first.slug]);
  });

  test("addWithResult distinguishes a new registration from an existing workspace", async () => {
    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });

    const first = await registry.addWithResult({ workspaceRoot: tmpWorkspaceA, name: "Original" });
    const second = await registry.addWithResult({ workspaceRoot: tmpWorkspaceA, name: "Ignored" });

    expect(first.created).toBe(true);
    expect(second).toEqual({ created: false, project: first.project });
  });

  test("add rejects non-absolute workspaceRoot with ProjectRegistryError", async () => {
    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });

    await expect(registry.add({ workspaceRoot: "relative/project" })).rejects.toThrow(ProjectRegistryError);
  });

  test("add rejects an empty project identity before persistence", async () => {
    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });

    await expect(registry.add({ workspaceRoot: tmpWorkspaceA, name: "   " }))
      .rejects.toThrow(ProjectRegistryError);
  });

  test("add rejects non-existent directory with ProjectRegistryError", async () => {
    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });
    const missingWorkspace = join(tmpHome, "missing");

    await expect(registry.add({ workspaceRoot: missingWorkspace })).rejects.toThrow(ProjectRegistryError);
  });

  test("add rejects file path with ProjectRegistryError", async () => {
    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });
    const filePath = join(tmpHome, "not-a-directory.txt");
    await writeFile(filePath, "not a directory");

    await expect(registry.add({ workspaceRoot: filePath })).rejects.toThrow(ProjectRegistryError);
  });

  test("slug conflict appends -2 and -3 suffixes", async () => {
    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });
    const parentA = await mkdtemp(join(tmpdir(), "archcode-same-a-"));
    const parentB = await mkdtemp(join(tmpdir(), "archcode-same-b-"));
    const parentC = await mkdtemp(join(tmpdir(), "archcode-same-c-"));
    const workspaceA = join(parentA, "api");
    const workspaceB = join(parentB, "api");
    const workspaceC = join(parentC, "api");

    try {
      await mkdir(workspaceA);
      await mkdir(workspaceB);
      await mkdir(workspaceC);

      const first = await registry.add({ workspaceRoot: workspaceA });
      const second = await registry.add({ workspaceRoot: workspaceB });
      const third = await registry.add({ workspaceRoot: workspaceC });

      expect(first.slug).toBe("api");
      expect(second.slug).toBe("api-2");
      expect(third.slug).toBe("api-3");
    } finally {
      await rm(parentA, { recursive: true, force: true });
      await rm(parentB, { recursive: true, force: true });
      await rm(parentC, { recursive: true, force: true });
    }
  });

  test("CRUD round-trip adds, gets, lists, and idempotently removes projects", async () => {
    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });

    const projectA = await registry.add({ workspaceRoot: tmpWorkspaceA, name: "Project A" });
    const projectB = await registry.add({ workspaceRoot: tmpWorkspaceB, name: "Project B" });

    expect(await registry.list()).toHaveLength(2);
    expect(await registry.get(projectA.slug)).toEqual(projectA);
    expect(await registry.get(projectB.slug)).toEqual(projectB);
    expect(await registry.getByWorkspace(tmpWorkspaceA)).toEqual(projectA);

    await expect(registry.remove(projectA.slug)).resolves.toEqual(projectA);
    expect(await registry.list()).toEqual([projectB]);
    expect(await registry.get(projectA.slug)).toBeUndefined();

    await expect(registry.remove(projectA.slug)).resolves.toBeUndefined();
  });

  test("touch updates lastOpenedAt and returns updated info", async () => {
    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });
    const project = await registry.add({ workspaceRoot: tmpWorkspaceA });
    await delay();

    const updated = await registry.touch(project.slug);

    expect(updated?.slug).toBe(project.slug);
    expect(updated?.lastOpenedAt).toEqual(expect.any(String));
    expect(Date.parse(updated?.lastOpenedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(project.addedAt));
    expect((await registry.get(project.slug))?.lastOpenedAt).toBe(updated?.lastOpenedAt);
  });

  test("touch on missing slug returns undefined", async () => {
    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });

    await expect(registry.touch("missing")).resolves.toBeUndefined();
  });

  test("updateName trims and updates only the project display name", async () => {
    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });
    const project = await registry.add({ workspaceRoot: tmpWorkspaceA, name: "Original" });
    const touched = await registry.touch(project.slug);
    expect(touched).toBeDefined();

    const updated = await registry.updateName(project.slug, "  Renamed Project  ");

    expect(updated).toEqual({
      ...touched!,
      name: "Renamed Project",
    });
    expect(await registry.get(project.slug)).toEqual(updated);
  });

  test("updateName allows duplicate display names without changing slugs", async () => {
    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });
    const first = await registry.add({ workspaceRoot: tmpWorkspaceA, name: "First" });
    const second = await registry.add({ workspaceRoot: tmpWorkspaceB, name: "Second" });

    const updated = await registry.updateName(second.slug, "First");

    expect(updated.name).toBe("First");
    expect(updated.slug).toBe(second.slug);
    expect((await registry.get(first.slug))?.name).toBe("First");
  });

  test("updateName rejects empty names after trimming", async () => {
    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });
    const project = await registry.add({ workspaceRoot: tmpWorkspaceA, name: "Original" });

    await expect(registry.updateName(project.slug, "   ")).rejects.toThrow(ProjectRegistryError);
    expect((await registry.get(project.slug))?.name).toBe("Original");
  });

  test("updateName rejects names longer than 80 characters", async () => {
    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });
    const project = await registry.add({ workspaceRoot: tmpWorkspaceA, name: "Original" });

    await expect(registry.updateName(project.slug, "a".repeat(81))).rejects.toThrow(ProjectRegistryError);
    expect((await registry.get(project.slug))?.name).toBe("Original");
  });

  test("updateName throws ProjectRegistryError for unknown slug", async () => {
    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });

    await expect(registry.updateName("missing", "Renamed")).rejects.toThrow(ProjectRegistryError);
  });

  test("persistence loads entries from a new registry instance with same homeDir", async () => {
    const firstRegistry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });
    const project = await firstRegistry.add({ workspaceRoot: tmpWorkspaceA });
    const secondRegistry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });

    expect(await secondRegistry.list()).toEqual([project]);
  });

  test("load rejects malformed persisted JSON instead of replacing it with an empty registry", async () => {
    const { logger } = createInMemoryLogger();
    const registryDir = join(tmpHome, ".archcode", "projects");
    await mkdir(registryDir, { recursive: true });
    await writeFile(join(registryDir, "index.json"), "{ malformed json");

    const registry = new ProjectRegistry({ homeDir: tmpHome, logger });

    await expect(registry.list()).rejects.toThrow(ProjectRegistryError);
  });

  test("load rejects the removed registry version field", async () => {
    const registryDir = join(tmpHome, ".archcode", "projects");
    await mkdir(registryDir, { recursive: true });
    await writeFile(join(registryDir, "index.json"), JSON.stringify({ version: 1, projects: [] }));

    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });

    await expect(registry.list()).rejects.toThrow(ProjectRegistryError);
  });

  test("load rejects duplicate persisted project identities", async () => {
    const registryDir = join(tmpHome, ".archcode", "projects");
    await mkdir(registryDir, { recursive: true });
    const addedAt = new Date().toISOString();
    const projectA = { slug: "duplicate", name: "Project A", workspaceRoot: tmpWorkspaceA, addedAt };
    const projectB = { slug: "duplicate", name: "Project B", workspaceRoot: tmpWorkspaceB, addedAt };
    await writeFile(join(registryDir, "index.json"), JSON.stringify({ projects: [projectA, projectB] }));

    await expect(new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger }).list())
      .rejects.toThrow(ProjectRegistryError);

    const normalizedAlias = join(tmpWorkspaceA, "nested", "..");
    await writeFile(join(registryDir, "index.json"), JSON.stringify({
      projects: [projectA, { ...projectB, slug: "second", workspaceRoot: normalizedAlias }],
    }));
    await expect(new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger }).list())
      .rejects.toThrow(ProjectRegistryError);
  });

  test("missing file returns empty list without error", async () => {
    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });

    expect(await registry.list()).toEqual([]);
  });

  test("list sorts by lastOpenedAt fallback addedAt descending, then addedAt descending", async () => {
    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });

    const projectA = await registry.add({ workspaceRoot: tmpWorkspaceA, name: "A" });
    await delay();
    const projectB = await registry.add({ workspaceRoot: tmpWorkspaceB, name: "B" });
    await delay();
    const projectC = await registry.add({ workspaceRoot: tmpWorkspaceC, name: "C" });
    await delay();
    const touchedB = await registry.touch(projectB.slug);
    expect(touchedB).toBeDefined();

    const ordered = await registry.list();

    expect(ordered.map((project) => project.slug)).toEqual([touchedB!.slug, projectC.slug, projectA.slug]);
  });

  test("concurrent add serializes writes without data loss or duplicate slugs", async () => {
    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });

    const results = await Promise.all([
      registry.add({ workspaceRoot: tmpWorkspaceA }),
      registry.add({ workspaceRoot: tmpWorkspaceB }),
      registry.add({ workspaceRoot: tmpWorkspaceC }),
    ]);

    const projects = await registry.list();
    const slugs = projects.map((project) => project.slug);

    expect(projects).toHaveLength(3);
    expect(new Set(slugs).size).toBe(3);
    expect(new Set(results.map((project) => project.workspaceRoot))).toEqual(
      new Set([tmpWorkspaceA, tmpWorkspaceB, tmpWorkspaceC]),
    );
  });

  test("empty slug fallback uses project", async () => {
    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });

    const project = await registry.add({ workspaceRoot: tmpWorkspaceA, name: "---" });

    expect(project.slug).toBe("project");
    expect(project.name).toBe("---");
  });

  test("list returns defensive copies that cannot mutate the cache", async () => {
    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });
    const project = await registry.add({ workspaceRoot: tmpWorkspaceA });
    const listed = await registry.list();
    listed[0] = { ...listed[0], slug: "mutated" };

    expect((await registry.get(project.slug))?.slug).toBe(project.slug);
  });

  test("uses basename for default project name", async () => {
    const registry = new ProjectRegistry({ homeDir: tmpHome, logger: silentLogger });

    const project = await registry.add({ workspaceRoot: tmpWorkspaceA });

    expect(project.name).toBe(basename(tmpWorkspaceA));
  });
});
