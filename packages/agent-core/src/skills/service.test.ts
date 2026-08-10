import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BuiltinSkillPackage } from "./types";
import {
  DigestBoundCursorError,
  RESERVED_BUILTIN_SKILL_NAMES,
  SkillResourceNotFoundError,
  SkillPackageChangedError,
  SkillService,
  SkillValidationError,
} from "./index";

const tmpRoot = join(tmpdir(), `archcode-skill-service-${crypto.randomUUID()}`);

function markdown(name: string, body: string, description = `${name} guidance for focused tests.`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

function builtin(name: string, body: string, resources: BuiltinSkillPackage["resources"] = {}): BuiltinSkillPackage {
  return { entry: markdown(name, body), resources };
}

async function writeSkill(
  root: string,
  name: string,
  body: string,
  resources: Readonly<Record<string, string | Uint8Array>> = {},
  entry = markdown(name, body),
): Promise<void> {
  const packageRoot = join(root, name);
  await mkdir(packageRoot, { recursive: true });
  await Bun.write(join(packageRoot, "SKILL.md"), entry);
  for (const [path, value] of Object.entries(resources)) {
    const destination = join(packageRoot, ...path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await Bun.write(destination, value);
  }
}

describe("SkillService control plane", () => {
  const projectRoot = join(tmpRoot, "project");
  const projectArchcode = join(projectRoot, ".archcode", "skills");
  const projectAgents = join(projectRoot, ".agents", "skills");
  const userArchcode = join(tmpRoot, "user", ".archcode", "skills");
  const userAgents = join(tmpRoot, "user", ".agents", "skills");

  beforeEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    await mkdir(projectRoot, { recursive: true });
    await mkdir(userArchcode, { recursive: true });
    await mkdir(userAgents, { recursive: true });
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function service(builtinSkills: Readonly<Record<string, BuiltinSkillPackage>> = {}) {
    return new SkillService({
      userSkillsRoot: userArchcode,
      userAgentsSkillsRoot: userAgents,
      builtinSkills,
    });
  }

  test("applies all five source tiers in exact precedence order", async () => {
    const roots = [projectArchcode, projectAgents, userArchcode, userAgents] as const;
    const expected = ["project-archcode", "project-agents", "user-archcode", "user-agents", "builtin"] as const;
    for (let winner = 0; winner < expected.length; winner += 1) {
      await rm(join(projectRoot, ".archcode"), { recursive: true, force: true });
      await rm(join(projectRoot, ".agents"), { recursive: true, force: true });
      await rm(userArchcode, { recursive: true, force: true });
      await rm(userAgents, { recursive: true, force: true });
      for (let index = winner; index < roots.length; index += 1) {
        await writeSkill(roots[index]!, "tiered", expected[index]!, {
          [`resources/${expected[index]}.txt`]: expected[index]!,
        });
      }
      const resolved = await service({ tiered: builtin("tiered", "builtin") })
        .readForAgent(projectRoot, "tiered", ["tiered"]);
      expect(resolved?.source).toBe(expected[winner]);
      expect(resolved?.resources).toEqual(winner < roots.length
        ? [{ path: `resources/${expected[winner]}.txt`, bytes: expected[winner]!.length }]
        : []);
    }
  });

  test("keeps reserved lifecycle builtins unshadowable", async () => {
    const builtinSkills = Object.fromEntries(
      [...RESERVED_BUILTIN_SKILL_NAMES].map((name) => [name, builtin(name, "builtin")]),
    );
    for (const name of RESERVED_BUILTIN_SKILL_NAMES) {
      await writeSkill(projectArchcode, name, "project");
      const resolved = await service(builtinSkills).readForAgent(projectRoot, name, [name]);
      expect(resolved?.source).toBe("builtin");
      expect(resolved?.body).toContain("builtin");
      expect(await service(builtinSkills).readForAgent(projectRoot, name, [])).toBeNull();
      expect((await service(builtinSkills).listForAgent(projectRoot, []))
        .some((entry) => entry.name === name)).toBeFalse();
    }
  });

  test("allows custom winners outside the builtin allow-list while keeping builtin fallback gated", async () => {
    await writeSkill(projectArchcode, "custom-overlay", "custom body");
    const skills = service({
      "custom-overlay": builtin("custom-overlay", "shadowed builtin"),
      "builtin-only": builtin("builtin-only", "builtin body"),
    });

    const snapshot = await skills.snapshotForAgent(projectRoot, "custom-overlay", []);
    expect(snapshot).toMatchObject({ name: "custom-overlay", source: "project-archcode" });
    await expect(skills.restoreSnapshotForAgent(projectRoot, "custom-overlay", snapshot!, []))
      .resolves.toMatchObject({ source: "project-archcode", digest: snapshot!.digest });
    expect(await skills.snapshotForAgent(projectRoot, "builtin-only", [])).toBeNull();

    await Bun.write(join(projectArchcode, "custom-overlay", "SKILL.md"), markdown("custom-overlay", "changed"));
    await expect(skills.restoreSnapshotForAgent(projectRoot, "custom-overlay", snapshot!, []))
      .rejects.toMatchObject({ code: "SKILL_PACKAGE_CHANGED" });
  });

  test("isolates an invalid winner, diagnoses every candidate, and never falls back or merges", async () => {
    await writeSkill(
      projectArchcode,
      "atomic",
      "broken",
      {},
      markdown("wrong-name", "broken"),
    );
    await writeSkill(userArchcode, "atomic", "lower", { "lower.txt": "lower" });
    const skills = service({ atomic: builtin("atomic", "builtin", { "builtin.txt": "builtin" }) });
    const catalog = await skills.catalogForAgent(projectRoot, ["atomic"]);

    expect(catalog.entries).toEqual([]);
    expect(catalog.inventory.map(({ source, winner, shadowed, valid }) => ({ source, winner, shadowed, valid })))
      .toEqual([
        { source: "project-archcode", winner: true, shadowed: false, valid: false },
        { source: "user-archcode", winner: false, shadowed: true, valid: true },
        { source: "builtin", winner: false, shadowed: true, valid: true },
      ]);
    expect(catalog.diagnostics).toHaveLength(1);
    expect(catalog.diagnostics[0]).toMatchObject({
      name: "atomic",
      source: "project-archcode",
      code: "SKILL_INVALID_PACKAGE",
    });
    expect(catalog.diagnostics[0]?.message).not.toContain(tmpRoot);
    await expect(skills.readForAgent(projectRoot, "atomic", ["atomic"]))
      .rejects.toBeInstanceOf(SkillValidationError);
  });

  test("never reads a missing winner resource from a shadowed package", async () => {
    await writeSkill(projectArchcode, "atomic", "winner");
    await writeSkill(userArchcode, "atomic", "lower", { "lower.txt": "lower" });
    await expect(service().readResourceForAgent(projectRoot, "atomic", "lower.txt"))
      .rejects.toBeInstanceOf(SkillResourceNotFoundError);
  });

  test("captures immutable private bytes and a digest sensitive to tier, entry, path, length, and content", async () => {
    await writeSkill(projectAgents, "snapshot", "entry-a", { "a.bin": Uint8Array.from([1, 2, 3]) });
    const skills = service();
    const first = await skills.snapshotForAgent(projectRoot, "snapshot");
    expect(first).not.toBeNull();
    const firstDigest = first!.digest;
    const firstRead = first!.readResource("a.bin");
    firstRead.content[0] = 99;

    await Bun.write(join(projectAgents, "snapshot", "a.bin"), Uint8Array.from([9, 2, 3]));
    expect([...first!.readResource("a.bin").content]).toEqual([1, 2, 3]);
    expect((await skills.snapshotForAgent(projectRoot, "snapshot"))?.digest).not.toBe(firstDigest);
    await expect(skills.restoreSnapshotForAgent(projectRoot, "snapshot", first!))
      .rejects.toMatchObject({ code: "SKILL_PACKAGE_CHANGED" } satisfies Partial<SkillPackageChangedError>);

    await Bun.write(join(projectAgents, "snapshot", "a.bin"), Uint8Array.from([1, 2, 3, 4]));
    const lengthDigest = (await skills.snapshotForAgent(projectRoot, "snapshot"))!.digest;
    expect(lengthDigest).not.toBe(firstDigest);

    await rm(join(projectAgents, "snapshot", "a.bin"));
    await Bun.write(join(projectAgents, "snapshot", "renamed.bin"), Uint8Array.from([1, 2, 3]));
    expect((await skills.snapshotForAgent(projectRoot, "snapshot"))?.digest).not.toBe(firstDigest);

    await Bun.write(join(projectAgents, "snapshot", "SKILL.md"), markdown("snapshot", "entry-b"));
    expect((await skills.snapshotForAgent(projectRoot, "snapshot"))?.digest).not.toBe(firstDigest);

    await writeSkill(projectArchcode, "snapshot", "entry-a", { "a.bin": Uint8Array.from([1, 2, 3]) });
    const higher = await skills.snapshotForAgent(projectRoot, "snapshot");
    expect(higher?.source).toBe("project-archcode");
    expect(higher?.digest).not.toBe(firstDigest);
  });

  test("maps every unavailable or changed restore state to SKILL_PACKAGE_CHANGED", async () => {
    await writeSkill(projectAgents, "restore", "entry", { "resource.txt": "before" });
    const skills = service();
    const snapshot = (await skills.snapshotForAgent(projectRoot, "restore"))!;

    await rm(join(projectAgents, "restore"), { recursive: true, force: true });
    await expect(skills.restoreSnapshotForAgent(projectRoot, "restore", snapshot))
      .rejects.toMatchObject({ code: "SKILL_PACKAGE_CHANGED" });

    await writeSkill(
      projectAgents,
      "restore",
      "invalid",
      {},
      markdown("wrong-name", "invalid"),
    );
    await expect(skills.restoreSnapshotForAgent(projectRoot, "restore", snapshot))
      .rejects.toMatchObject({ code: "SKILL_PACKAGE_CHANGED" });

    await rm(join(projectAgents, "restore"), { recursive: true, force: true });
    await writeSkill(projectAgents, "restore", "entry", { "resource.txt": "before" });
    await expect(skills.restoreSnapshotForAgent(projectRoot, "restore", {
      source: "builtin",
      digest: snapshot.digest,
    })).rejects.toMatchObject({ code: "SKILL_PACKAGE_CHANGED" });

    await Bun.write(join(projectAgents, "restore", "resource.txt"), "after");
    await expect(skills.restoreSnapshotForAgent(projectRoot, "restore", snapshot))
      .rejects.toMatchObject({ code: "SKILL_PACKAGE_CHANGED" });
  });

  test("keeps catalog discovery metadata-only and its digest bound to visible state", async () => {
    await writeSkill(projectArchcode, "metadata-only", "entry", { "resource.txt": "before" });
    await symlink(
      join(projectArchcode, "metadata-only", "resource.txt"),
      join(projectArchcode, "metadata-only", "linked-resource.txt"),
    );
    const skills = service();

    const first = await skills.catalogForAgent(projectRoot, ["metadata-only"]);
    expect(first.entries).toEqual([{
      name: "metadata-only",
      description: "metadata-only guidance for focused tests.",
      source: "project-archcode",
    }]);
    expect(await skills.discoverForAgent(projectRoot, "metadata-only", ["metadata-only"]))
      .toEqual(first.entries[0]!);
    await Bun.write(join(projectArchcode, "metadata-only", "resource.txt"), "after");
    expect((await skills.catalogForAgent(projectRoot, ["metadata-only"])).digest).toBe(first.digest);
    await expect(skills.snapshotForAgent(projectRoot, "metadata-only", ["metadata-only"]))
      .rejects.toBeInstanceOf(SkillValidationError);
  });

  test("binds list cursors to whole-catalog content", async () => {
    for (let index = 0; index < 51; index += 1) {
      const name = `skill-${index}`;
      await writeSkill(
        projectArchcode,
        name,
        `body-${index}`,
        {},
        markdown(name, `body-${index}`, "x".repeat(200)),
      );
    }
    const skills = service();
    const first = await skills.listPageForAgent(projectRoot);
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toBeString();
    const inventoryFirst = await skills.inventoryPage(projectRoot);
    expect(inventoryFirst.items).toHaveLength(50);
    expect(inventoryFirst.nextCursor).toBeString();
    const inventorySecond = await skills.inventoryPage(projectRoot, inventoryFirst.nextCursor);
    expect(inventorySecond.items).toHaveLength(1);
    expect(inventorySecond.nextCursor).toBeUndefined();
    const projection = await skills.projectPromptCatalog(projectRoot);
    expect(projection.omittedCount).toBeGreaterThan(0);
    expect(projection.byteLength).toBeLessThanOrEqual(8_000);
    await Bun.write(
      join(projectArchcode, "skill-50", "SKILL.md"),
      markdown("skill-50", "changed", "visible description changed"),
    );
    await expect(skills.listPageForAgent(projectRoot, undefined, first.nextCursor))
      .rejects.toMatchObject({ code: "TOOL_SKILL_CATALOG_CHANGED" } satisfies Partial<DigestBoundCursorError>);
  });
});
