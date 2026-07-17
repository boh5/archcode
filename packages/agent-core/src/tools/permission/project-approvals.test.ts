import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { silentLogger, type Logger } from "../../logger";
import type { PermissionApprovalScope } from "./policy-types";
import {
  PermissionApprovalFileSchema,
  ProjectApprovalLoadError,
  ProjectApprovalManager,
  ProjectApprovalPersistError,
} from "./project-approvals";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "project-approvals", crypto.randomUUID());
const WORKSPACE = join(TMP_DIR, "workspace");
const PERMISSIONS_PATH = join(WORKSPACE, ".archcode", "permissions.json");

const FILE_SCOPE: PermissionApprovalScope = {
  kind: "file-path",
  operation: "write",
  path: "src/main.ts",
  pathMode: "exact",
};

const OTHER_FILE_SCOPE: PermissionApprovalScope = {
  kind: "file-path",
  operation: "write",
  path: "src/other.ts",
  pathMode: "exact",
};

function makeManager(logger?: Logger): ProjectApprovalManager {
  return new ProjectApprovalManager(logger ?? silentLogger);
}

function readPermissionFile(): unknown {
  return JSON.parse(readFileSync(PERMISSIONS_PATH, "utf8"));
}

beforeEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("ProjectApprovalManager", () => {
  test("missing permissions file stays absent until the first persistent approval", async () => {
    const manager = makeManager();

    await manager.load(WORKSPACE);

    expect(manager.listApprovals()).toEqual([]);
    expect(manager.hasApproval(FILE_SCOPE)).toBe(false);
    expect(existsSync(PERMISSIONS_PATH)).toBe(false);

    await manager.addApproval(FILE_SCOPE, { display: "Write file", reason: "Persist first approval" });
    expect(existsSync(PERMISSIONS_PATH)).toBe(true);
  });

  test("malformed permissions file fails closed with a typed load error", async () => {
    mkdirSync(join(WORKSPACE, ".archcode"), { recursive: true });
    writeFileSync(PERMISSIONS_PATH, "{ malformed json");
    const logger: Logger = {
      debug: mock(),
      info: mock(),
      warn: mock(),
      error: mock(),
      child: () => logger,
    };
    const manager = makeManager(logger);

    await expect(manager.load(WORKSPACE)).rejects.toBeInstanceOf(ProjectApprovalLoadError);

    expect(manager.listApprovals()).toEqual([]);
    expect(manager.hasApproval(FILE_SCOPE)).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("removed permissions file version fails closed instead of resetting authority", async () => {
    mkdirSync(join(WORKSPACE, ".archcode"), { recursive: true });
    writeFileSync(PERMISSIONS_PATH, JSON.stringify({ version: 1, approvals: [] }));
    const manager = makeManager();

    await expect(manager.load(WORKSPACE)).rejects.toMatchObject({
      name: "ProjectApprovalLoadError",
      path: PERMISSIONS_PATH,
    });

    expect(manager.listApprovals()).toEqual([]);
    expect(manager.hasApproval(FILE_SCOPE)).toBe(false);
  });

  test("persist failure propagates, does not grant in memory, and the write queue recovers", async () => {
    const manager = makeManager();
    await manager.load(WORKSPACE);
    writeFileSync(join(WORKSPACE, ".archcode"), "not a directory");

    await expect(manager.addApproval(FILE_SCOPE, {
      display: "Write src/main.ts",
      reason: "First write must fail",
    })).rejects.toBeInstanceOf(ProjectApprovalPersistError);

    expect(manager.hasApproval(FILE_SCOPE)).toBe(false);
    expect(manager.listApprovals()).toEqual([]);

    rmSync(join(WORKSPACE, ".archcode"), { force: true });
    const approval = await manager.addApproval(FILE_SCOPE, {
      display: "Write src/main.ts",
      reason: "Retry after storage recovery",
    });

    expect(manager.hasApproval(FILE_SCOPE)).toBe(true);
    expect(PermissionApprovalFileSchema.parse(readPermissionFile()).approvals).toEqual([approval]);
  });

  test("writes deterministic strict JSON and reloads matching behavior", async () => {
    const manager = makeManager();
    await manager.load(WORKSPACE);

    const approval = await manager.addApproval(FILE_SCOPE, {
      display: "Write src/main.ts",
      reason: "User approved writing src/main.ts",
      grantedBy: { agentName: "Engineer", depth: 0 },
    });

    const raw = readFileSync(PERMISSIONS_PATH, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).not.toContain('"version"');
    expect(raw).toContain('    {\n      "id"');
    expect(PermissionApprovalFileSchema.parse(JSON.parse(raw)).approvals[0]).toEqual(approval);

    const reloaded = makeManager();
    await reloaded.load(WORKSPACE);

    expect(reloaded.hasApproval(FILE_SCOPE)).toBe(true);
    expect(reloaded.hasApproval(OTHER_FILE_SCOPE)).toBe(false);
    expect(reloaded.listApprovals()).toEqual([approval]);
  });

  test("adding the same structured scope twice is idempotent", async () => {
    const manager = makeManager();
    await manager.load(WORKSPACE);

    const first = await manager.addApproval(FILE_SCOPE, {
      display: "First display",
      reason: "First reason",
    });
    const second = await manager.addApproval({ ...FILE_SCOPE }, {
      display: "Second display",
      reason: "Second reason",
    });

    expect(second).toEqual(first);
    expect(manager.listApprovals()).toHaveLength(1);
    expect(PermissionApprovalFileSchema.parse(readPermissionFile()).approvals).toHaveLength(1);
  });

  test("display text is not matching authority", async () => {
    const manager = makeManager();
    await manager.load(WORKSPACE);
    await manager.addApproval(FILE_SCOPE, {
      display: "Shared display",
      reason: "Structured scope is authoritative",
    });

    const file = PermissionApprovalFileSchema.parse(readPermissionFile());
    file.approvals[0] = {
      ...file.approvals[0]!,
      display: "Changed display",
    };
    writeFileSync(PERMISSIONS_PATH, `${JSON.stringify(file, null, 2)}\n`);

    const reloaded = makeManager();
    await reloaded.load(WORKSPACE);

    expect(reloaded.hasApproval(FILE_SCOPE)).toBe(true);
    expect(reloaded.hasApproval(OTHER_FILE_SCOPE)).toBe(false);
  });

  test("reloadIfStale reloads when permissions file mtime changes", async () => {
    const manager = makeManager();
    await manager.load(WORKSPACE);
    await manager.addApproval(FILE_SCOPE, {
      display: "Write src/main.ts",
      reason: "Initial approval",
    });

    const file = PermissionApprovalFileSchema.parse(readPermissionFile());
    file.approvals = [{
      ...file.approvals[0]!,
      scope: OTHER_FILE_SCOPE,
      display: "Write src/other.ts",
      reason: "Externally updated approval",
    }];
    writeFileSync(PERMISSIONS_PATH, `${JSON.stringify(file, null, 2)}\n`);
    const future = new Date(Date.now() + 5_000);
    utimesSync(PERMISSIONS_PATH, future, future);

    await manager.reloadIfStale(WORKSPACE);

    expect(manager.hasApproval(FILE_SCOPE)).toBe(false);
    expect(manager.hasApproval(OTHER_FILE_SCOPE)).toBe(true);
    expect(manager.listApprovals()[0]?.display).toBe("Write src/other.ts");
  });

  test("serializes concurrent writes so the latest file contains all approvals", async () => {
    const manager = makeManager();
    await manager.load(WORKSPACE);
    const bashScope: PermissionApprovalScope = {
      kind: "bash-exact",
      command: "bun test",
      cwd: WORKSPACE,
      accesses: [],
    };

    await Promise.all([
      manager.addApproval(FILE_SCOPE, {
        display: "Write file",
        reason: "Concurrent file approval",
      }),
      manager.addApproval(bashScope, {
        display: "Run tests",
        reason: "Concurrent bash approval",
      }),
    ]);

    const reloaded = makeManager();
    await reloaded.load(WORKSPACE);

    expect(reloaded.hasApproval(FILE_SCOPE)).toBe(true);
    expect(reloaded.hasApproval(bashScope)).toBe(true);
    expect(reloaded.listApprovals()).toHaveLength(2);
  });

  test.each([
    { kind: "bash-command", command: "bun", subcommands: ["test"], argumentMode: "any", effects: ["execute-code"] },
    { kind: "bash-exact", normalized: "bun test", effects: ["execute-code"] },
  ])("rejects a file containing legacy Bash scope $kind with cleanup guidance", async (scope) => {
    mkdirSync(join(WORKSPACE, ".archcode"), { recursive: true });
    writeFileSync(PERMISSIONS_PATH, JSON.stringify({
      approvals: [{
        id: crypto.randomUUID(),
        scope,
        display: "Legacy Bash approval",
        reason: "Legacy",
        grantedAt: new Date().toISOString(),
      }],
    }));

    await expect(makeManager().load(WORKSPACE)).rejects.toThrow(/Remove every bash-command or old-shape bash-exact entry/);
  });

  test("rejects a mixed valid non-Bash and legacy Bash file with its path and cleanup guidance", async () => {
    mkdirSync(join(WORKSPACE, ".archcode"), { recursive: true });
    writeFileSync(PERMISSIONS_PATH, JSON.stringify({
      approvals: [
        {
          id: crypto.randomUUID(), scope: FILE_SCOPE, display: "Write file", reason: "Valid non-Bash approval", grantedAt: new Date().toISOString(),
        },
        {
          id: crypto.randomUUID(), scope: { kind: "bash-command", command: "bun" }, display: "Legacy Bash", reason: "Legacy", grantedAt: new Date().toISOString(),
        },
      ],
    }));

    let failure: unknown;
    try {
      await makeManager().load(WORKSPACE);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProjectApprovalLoadError);
    expect(String(failure)).toContain(PERMISSIONS_PATH);
    expect(String(failure)).toContain("Remove every bash-command or old-shape bash-exact entry");
  });
});
