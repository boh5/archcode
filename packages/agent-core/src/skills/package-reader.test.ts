import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  activateBuiltinSkill,
  activateFilesystemSkill as activateFilesystemSkillAt,
  discoverFilesystemSkill as discoverFilesystemSkillAt,
  readBuiltinSkillResource,
  readFilesystemSkillResource as readFilesystemSkillResourceAt,
  SkillPackageResourceNotFoundError,
  SKILL_PACKAGE_MAX_BYTES,
  SKILL_PACKAGE_MAX_ENTRIES,
  SKILL_RESOURCE_MAX_BYTES,
  SKILL_RESOURCE_MAX_DEPTH,
  SKILL_RESOURCE_MAX_FILES,
  validateResourcePath,
} from "./package-reader";
import type { BuiltinSkillPackage } from "./types";

const tmpRoot = join(import.meta.dir, "__test_tmp__", "package-reader", crypto.randomUUID());
const encoder = new TextEncoder();

function entry(name = "test-skill", body = "Entry body.\n"): string {
  return `---
name: ${name}
description: Provides package-reader guidance when Skill packages are being validated.
---

${body}`;
}

function builtin(
  resources: Readonly<Record<string, string | Uint8Array>>,
  name = "test-skill",
): BuiltinSkillPackage {
  return { entry: entry(name), resources };
}

async function writePackage(
  packageRoot: string,
  resources: Readonly<Record<string, string | Uint8Array>> = {},
  markdown = entry(),
): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await Bun.write(join(packageRoot, "SKILL.md"), markdown);
  for (const [path, value] of Object.entries(resources)) {
    const destination = join(packageRoot, ...path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await Bun.write(destination, value);
  }
}

function filesystemLocation(packageRoot: string) {
  return { boundaryRoot: dirname(packageRoot), root: packageRoot };
}

function discoverFilesystemSkill(packageRoot: string, expectedName: string) {
  return discoverFilesystemSkillAt(filesystemLocation(packageRoot), expectedName);
}

function activateFilesystemSkill(packageRoot: string, expectedName: string) {
  return activateFilesystemSkillAt(filesystemLocation(packageRoot), expectedName);
}

function readFilesystemSkillResource(packageRoot: string, expectedName: string, resource: string) {
  return readFilesystemSkillResourceAt(filesystemLocation(packageRoot), expectedName, resource);
}

describe("Skill package reader", () => {
  beforeEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    await mkdir(tmpRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("discovery reads bounded metadata without validating the body or traversing resources", async () => {
    const packageRoot = join(tmpRoot, "discovery", "test-skill");
    await writePackage(packageRoot);
    await Bun.write(join(packageRoot, "SKILL.md"), new Blob([entry(), Uint8Array.from([0xff])]));
    await symlink(join(tmpRoot, "outside"), join(packageRoot, "linked-directory"));

    expect(await discoverFilesystemSkill(packageRoot, "test-skill")).toEqual({
      name: "test-skill",
      description: "Provides package-reader guidance when Skill packages are being validated.",
    });
    await expect(activateFilesystemSkill(packageRoot, "test-skill")).rejects.toThrow("valid UTF-8");
  });

  test("activation returns stable sorted POSIX descriptors without SKILL.md contents", async () => {
    const packageRoot = join(tmpRoot, "sorted", "test-skill");
    const arbitraryBytes = Uint8Array.from([0x00, 0xff, 0x80, 0x41]);
    await writePackage(packageRoot, {
      "z-last.bin": arbitraryBytes,
      "references/b.md": "bbb",
      "assets/a.txt": "a",
    });

    const activated = await activateFilesystemSkill(packageRoot, "test-skill");
    expect(activated.resources).toEqual([
      { path: "assets/a.txt", bytes: 1 },
      { path: "references/b.md", bytes: 3 },
      { path: "z-last.bin", bytes: 4 },
    ]);
    expect(activated.resources.map((resource) => resource.path)).not.toContain("SKILL.md");
    const read = await readFilesystemSkillResource(packageRoot, "test-skill", "z-last.bin");
    expect([...read.content]).toEqual([...arbitraryBytes]);
  });

  test("builtin inventory and reads preserve arbitrary bytes", () => {
    const bytes = Uint8Array.from([0xff, 0xfe, 0x00, 0x61]);
    const skillPackage = builtin({ "assets/arbitrary.bin": bytes });

    expect(activateBuiltinSkill(skillPackage, "test-skill").resources).toEqual([
      { path: "assets/arbitrary.bin", bytes: 4 },
    ]);
    const read = readBuiltinSkillResource(skillPackage, "test-skill", "assets/arbitrary.bin");
    expect([...read.content]).toEqual([...bytes]);
    expect(read.content).not.toBe(bytes);
  });

  test("reports unlisted builtin and filesystem resources with the package not-found type", async () => {
    const skillPackage = builtin({ "assets/present.bin": "x" });
    expect(() => readBuiltinSkillResource(skillPackage, "test-skill", "assets/absent.bin"))
      .toThrow(SkillPackageResourceNotFoundError);
    try {
      readBuiltinSkillResource(skillPackage, "test-skill", "assets/absent.bin");
    } catch (error) {
      expect(error).toMatchObject({ name: "SkillPackageResourceNotFoundError" });
    }

    const packageRoot = join(tmpRoot, "not-found", "test-skill");
    await writePackage(packageRoot, { "references/guide.md": "guide" });
    await expect(readFilesystemSkillResource(packageRoot, "test-skill", "references/absent.md"))
      .rejects.toBeInstanceOf(SkillPackageResourceNotFoundError);
  });

  test("builtin packages cannot place resources below the SKILL.md entry path", () => {
    expect(() => activateBuiltinSkill(
      builtin({ "SKILL.md/hidden.txt": "impossible filesystem shape" }),
      "test-skill",
    )).toThrow("cannot be a resource directory");
  });

  test("rejects absolute, traversal, empty-segment, dot-segment, backslash, NUL, excessive-depth, and entry paths", () => {
    const invalid = [
      "",
      "/absolute.md",
      "../escape.md",
      "references/../escape.md",
      "references//file.md",
      "./file.md",
      "references/./file.md",
      "references\\file.md",
      "references/file\0.md",
      "SKILL.md",
      "SKILL.md/hidden.txt",
      [...Array(SKILL_RESOURCE_MAX_DEPTH).fill("d"), "file.md"].join("/"),
    ];
    for (const path of invalid) expect(() => validateResourcePath(path)).toThrow();

    expect(() => validateResourcePath("references/file.md")).not.toThrow();
  });

  test("enforces resource depth below, equal, and above the fixed limit", async () => {
    for (const depth of [SKILL_RESOURCE_MAX_DEPTH - 1, SKILL_RESOURCE_MAX_DEPTH]) {
      const path = pathAtDepth(depth);
      expect(activateBuiltinSkill(builtin({ [path]: "ok" }), "test-skill").resources[0]?.path).toBe(path);

      const packageRoot = join(tmpRoot, `filesystem-depth-${depth}`, "test-skill");
      await writePackage(packageRoot, { [path]: "ok" });
      expect((await activateFilesystemSkill(packageRoot, "test-skill")).resources[0]?.path).toBe(path);
    }
    expect(() => activateBuiltinSkill(
      builtin({ [pathAtDepth(SKILL_RESOURCE_MAX_DEPTH + 1)]: "too deep" }),
      "test-skill",
    )).toThrow(`depth exceeds ${SKILL_RESOURCE_MAX_DEPTH}`);

    const aboveRoot = join(tmpRoot, "filesystem-depth-above", "test-skill");
    await writePackage(aboveRoot, {
      [pathAtDepth(SKILL_RESOURCE_MAX_DEPTH + 1)]: "too deep",
    });
    await expect(activateFilesystemSkill(aboveRoot, "test-skill"))
      .rejects.toThrow(`depth exceeds ${SKILL_RESOURCE_MAX_DEPTH}`);
  });

  test("enforces one-resource bytes below, equal, and above the fixed limit", () => {
    for (const size of [SKILL_RESOURCE_MAX_BYTES - 1, SKILL_RESOURCE_MAX_BYTES]) {
      const activated = activateBuiltinSkill(
        builtin({ "assets/payload.bin": new Uint8Array(size) }),
        "test-skill",
      );
      expect(activated.resources).toEqual([{ path: "assets/payload.bin", bytes: size }]);
    }
    expect(() => activateBuiltinSkill(
      builtin({ "assets/payload.bin": new Uint8Array(SKILL_RESOURCE_MAX_BYTES + 1) }),
      "test-skill",
    )).toThrow(`exceeds ${SKILL_RESOURCE_MAX_BYTES} bytes`);
  });

  test("enforces filesystem resource bytes below, equal, and above the fixed limit", async () => {
    for (const size of [SKILL_RESOURCE_MAX_BYTES - 1, SKILL_RESOURCE_MAX_BYTES]) {
      const packageRoot = join(tmpRoot, `filesystem-resource-${size}`, "test-skill");
      await writePackage(packageRoot, { "assets/payload.bin": new Uint8Array(size) });
      expect((await activateFilesystemSkill(packageRoot, "test-skill")).resources).toEqual([
        { path: "assets/payload.bin", bytes: size },
      ]);
    }
    const aboveRoot = join(tmpRoot, "filesystem-resource-above", "test-skill");
    await writePackage(aboveRoot, {
      "assets/payload.bin": new Uint8Array(SKILL_RESOURCE_MAX_BYTES + 1),
    });
    await expect(activateFilesystemSkill(aboveRoot, "test-skill"))
      .rejects.toThrow(`exceeds ${SKILL_RESOURCE_MAX_BYTES} bytes`);
  });

  test("enforces resource-file count below, equal, and above the fixed limit", () => {
    for (const count of [SKILL_RESOURCE_MAX_FILES - 1, SKILL_RESOURCE_MAX_FILES]) {
      expect(activateBuiltinSkill(builtin(flatResources(count)), "test-skill").resources).toHaveLength(count);
    }
    expect(() => activateBuiltinSkill(
      builtin(flatResources(SKILL_RESOURCE_MAX_FILES + 1)),
      "test-skill",
    )).toThrow(`more than ${SKILL_RESOURCE_MAX_FILES} resource files`);
  });

  test("enforces filesystem resource-file count below, equal, and above the fixed limit", async () => {
    for (const count of [SKILL_RESOURCE_MAX_FILES - 1, SKILL_RESOURCE_MAX_FILES]) {
      const packageRoot = join(tmpRoot, `filesystem-count-${count}`, "test-skill");
      await writePackage(packageRoot, flatResources(count));
      expect((await activateFilesystemSkill(packageRoot, "test-skill")).resources).toHaveLength(count);
    }
    const aboveRoot = join(tmpRoot, "filesystem-count-above", "test-skill");
    await writePackage(aboveRoot, flatResources(SKILL_RESOURCE_MAX_FILES + 1));
    await expect(activateFilesystemSkill(aboveRoot, "test-skill"))
      .rejects.toThrow(`more than ${SKILL_RESOURCE_MAX_FILES} resource files`);
  });

  test("counts builtin implicit directories at directory-entry boundaries", () => {
    const below = resourcesWithImplicitDirectories(127, false);
    const equal = resourcesWithImplicitDirectories(127, true);
    const above = resourcesWithImplicitDirectories(128, false);

    expect(countImplicitEntries(below)).toBe(SKILL_PACKAGE_MAX_ENTRIES - 1);
    expect(activateBuiltinSkill(builtin(below), "test-skill").resources).toHaveLength(127);
    expect(countImplicitEntries(equal)).toBe(SKILL_PACKAGE_MAX_ENTRIES);
    expect(activateBuiltinSkill(builtin(equal), "test-skill").resources).toHaveLength(128);
    expect(countImplicitEntries(above)).toBe(SKILL_PACKAGE_MAX_ENTRIES + 1);
    expect(() => activateBuiltinSkill(builtin(above), "test-skill"))
      .toThrow(`more than ${SKILL_PACKAGE_MAX_ENTRIES} directory entries`);
  });

  test("enforces filesystem directory entries below, equal, and above the fixed limit", async () => {
    const cases = [
      { label: "below", resources: resourcesWithImplicitDirectories(127, false), expected: 127 },
      { label: "equal", resources: resourcesWithImplicitDirectories(127, true), expected: 128 },
    ] as const;
    for (const item of cases) {
      const packageRoot = join(tmpRoot, `filesystem-entries-${item.label}`, "test-skill");
      await writePackage(packageRoot, item.resources);
      expect((await activateFilesystemSkill(packageRoot, "test-skill")).resources).toHaveLength(item.expected);
    }

    const aboveRoot = join(tmpRoot, "filesystem-entries-above", "test-skill");
    await writePackage(aboveRoot, resourcesWithImplicitDirectories(128, false));
    await expect(activateFilesystemSkill(aboveRoot, "test-skill"))
      .rejects.toThrow(`more than ${SKILL_PACKAGE_MAX_ENTRIES} directory entries`);
  });

  test("enforces aggregate package bytes below, equal, and above the fixed limit", () => {
    const entryBytes = encoder.encode(entry()).byteLength;
    for (const total of [SKILL_PACKAGE_MAX_BYTES - 1, SKILL_PACKAGE_MAX_BYTES]) {
      const skillPackage = builtin(resourcesWithTotalBytes(total - entryBytes));
      const activated = activateBuiltinSkill(skillPackage, "test-skill");
      const actualTotal = entryBytes + activated.resources.reduce((sum, resource) => sum + resource.bytes, 0);
      expect(actualTotal).toBe(total);
    }
    expect(() => activateBuiltinSkill(
      builtin(resourcesWithTotalBytes(SKILL_PACKAGE_MAX_BYTES + 1 - entryBytes)),
      "test-skill",
    )).toThrow(`exceeds ${SKILL_PACKAGE_MAX_BYTES} aggregate bytes`);
  });

  test("enforces filesystem aggregate bytes below, equal, and above the fixed limit", async () => {
    const entryBytes = encoder.encode(entry()).byteLength;
    for (const total of [SKILL_PACKAGE_MAX_BYTES - 1, SKILL_PACKAGE_MAX_BYTES]) {
      const packageRoot = join(tmpRoot, `filesystem-aggregate-${total}`, "test-skill");
      await writePackage(packageRoot, resourcesWithTotalBytes(total - entryBytes));
      const activated = await activateFilesystemSkill(packageRoot, "test-skill");
      const actualTotal = entryBytes + activated.resources.reduce((sum, resource) => sum + resource.bytes, 0);
      expect(actualTotal).toBe(total);
    }

    const aboveRoot = join(tmpRoot, "filesystem-aggregate-above", "test-skill");
    await writePackage(
      aboveRoot,
      resourcesWithTotalBytes(SKILL_PACKAGE_MAX_BYTES + 1 - entryBytes),
    );
    await expect(activateFilesystemSkill(aboveRoot, "test-skill"))
      .rejects.toThrow(`exceeds ${SKILL_PACKAGE_MAX_BYTES} aggregate bytes`);
  });

  test("rejects symlinked package roots, entries, directories, and resources", async () => {
    const targetRoot = join(tmpRoot, "symlinks", "target-root");
    await writePackage(targetRoot);
    const linkedRoot = join(tmpRoot, "symlinks", "linked-root");
    await symlink(targetRoot, linkedRoot, "dir");
    await expect(activateFilesystemSkill(linkedRoot, "test-skill")).rejects.toThrow("must not be a symlink");

    const entryRoot = join(tmpRoot, "symlinks", "entry-root");
    await mkdir(entryRoot, { recursive: true });
    const externalEntry = join(tmpRoot, "symlinks", "external-entry.md");
    await Bun.write(externalEntry, entry());
    await symlink(externalEntry, join(entryRoot, "SKILL.md"), "file");
    await expect(activateFilesystemSkill(entryRoot, "test-skill")).rejects.toThrow("must not be a symlink");

    const directoryRoot = join(tmpRoot, "symlinks", "directory-root");
    await writePackage(directoryRoot);
    const externalDirectory = join(tmpRoot, "symlinks", "external-directory");
    await mkdir(externalDirectory, { recursive: true });
    await symlink(externalDirectory, join(directoryRoot, "references"), "dir");
    await expect(activateFilesystemSkill(directoryRoot, "test-skill")).rejects.toThrow("symlinks are not allowed");

    const resourceRoot = join(tmpRoot, "symlinks", "resource-root");
    await writePackage(resourceRoot);
    const externalResource = join(tmpRoot, "symlinks", "external-resource.md");
    await Bun.write(externalResource, "outside");
    await symlink(externalResource, join(resourceRoot, "resource.md"), "file");
    await expect(activateFilesystemSkill(resourceRoot, "test-skill")).rejects.toThrow("symlinks are not allowed");
  });

  test("requires the filesystem entry name to be exactly SKILL.md", async () => {
    const packageRoot = join(tmpRoot, "entry-case", "test-skill");
    await mkdir(packageRoot, { recursive: true });
    await Bun.write(join(packageRoot, "skill.md"), entry());

    await expect(discoverFilesystemSkill(packageRoot, "test-skill"))
      .rejects.toThrow("must be named exactly SKILL.md");
    await expect(activateFilesystemSkill(packageRoot, "test-skill"))
      .rejects.toThrow("must be named exactly SKILL.md");
    expect(() => validateResourcePath("skill.md")).toThrow("cannot be a resource");
    expect(() => validateResourcePath("skill.md/hidden.txt")).toThrow("cannot be a resource");
  });

  test("rejects a symlink in package ancestry below the trusted source boundary", async () => {
    const boundaryRoot = join(tmpRoot, "ancestry", "project");
    const externalSkillsRoot = join(tmpRoot, "ancestry", "external-skills");
    const externalPackageRoot = join(externalSkillsRoot, "test-skill");
    await writePackage(externalPackageRoot);
    await mkdir(join(boundaryRoot, ".archcode"), { recursive: true });
    await symlink(externalSkillsRoot, join(boundaryRoot, ".archcode", "skills"), "dir");
    const lexicalPackageRoot = join(boundaryRoot, ".archcode", "skills", "test-skill");
    const location = { boundaryRoot, root: lexicalPackageRoot };

    await expect(discoverFilesystemSkillAt(location, "test-skill"))
      .rejects.toThrow("must not be a symlink");
    await expect(activateFilesystemSkillAt(location, "test-skill"))
      .rejects.toThrow("must not be a symlink");
    await expect(readFilesystemSkillResourceAt(location, "test-skill", "missing.md"))
      .rejects.toThrow("must not be a symlink");
  });

  test("rejects a non-UTF-8 SKILL.md without rejecting arbitrary-byte resources", async () => {
    const packageRoot = join(tmpRoot, "utf8", "test-skill");
    await writePackage(packageRoot, { "assets/valid.bin": Uint8Array.from([0xff, 0xfe]) });
    expect((await activateFilesystemSkill(packageRoot, "test-skill")).resources).toEqual([
      { path: "assets/valid.bin", bytes: 2 },
    ]);

    await Bun.write(join(packageRoot, "SKILL.md"), new Blob([entry(), Uint8Array.from([0xff])]));
    await expect(activateFilesystemSkill(packageRoot, "test-skill")).rejects.toThrow("valid UTF-8");
  });

  test("validates resource input again before filesystem access", async () => {
    const packageRoot = join(tmpRoot, "input", "test-skill");
    await writePackage(packageRoot, { "references/guide.md": "guide" });

    const cases = [
      { resource: "/tmp/outside", message: "must be relative" },
      { resource: "../outside", message: "invalid segment" },
      { resource: "references\\guide.md", message: "POSIX separators" },
      { resource: "references//guide.md", message: "invalid segment" },
    ] as const;
    for (const item of cases) {
      await expect(readFilesystemSkillResource(packageRoot, "test-skill", item.resource))
        .rejects.toThrow(item.message);
    }
  });
});

function pathAtDepth(depth: number): string {
  if (depth < 1) throw new Error("Depth must be positive");
  return [...Array(Math.max(0, depth - 1)).fill("d"), "file.bin"].join("/");
}

function flatResources(count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`resource-${String(index).padStart(3, "0")}.txt`, "x"]),
  );
}

function resourcesWithImplicitDirectories(
  directoryCount: number,
  addExtraResource: boolean,
): Record<string, string> {
  const resources = Object.fromEntries(
    Array.from({ length: directoryCount }, (_, index) => [
      `d-${String(index).padStart(3, "0")}/resource.txt`,
      "x",
    ]),
  );
  if (addExtraResource) resources["d-000/extra.txt"] = "x";
  return resources;
}

function countImplicitEntries(resources: Readonly<Record<string, unknown>>): number {
  const directories = new Set<string>();
  for (const path of Object.keys(resources)) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return 1 + Object.keys(resources).length + directories.size;
}

function resourcesWithTotalBytes(totalBytes: number): Record<string, Uint8Array> {
  const resources: Record<string, Uint8Array> = {};
  let remaining = totalBytes;
  let index = 0;
  while (remaining > 0) {
    const size = Math.min(SKILL_RESOURCE_MAX_BYTES, remaining);
    resources[`assets/chunk-${index}.bin`] = new Uint8Array(size);
    remaining -= size;
    index += 1;
  }
  return resources;
}
