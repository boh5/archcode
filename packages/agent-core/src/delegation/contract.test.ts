import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChildResult, DelegationContract } from "@archcode/protocol";
import {
  delegationScopesOverlap,
  hashDelegationContract,
  normalizeScopeRef,
  validateChildResultAgainstContract,
  validateScopeRefInWorkspace,
} from "./contract";

const TMP = join(import.meta.dir, "__test_tmp__", crypto.randomUUID());
const WORKSPACE = join(TMP, "workspace");
const OUTSIDE = join(TMP, "outside");

beforeEach(async () => {
  await mkdir(join(WORKSPACE, "src"), { recursive: true });
  await mkdir(OUTSIDE, { recursive: true });
  await writeFile(join(WORKSPACE, "src", "file.ts"), "export {}\n");
});

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

function contract(): DelegationContract {
  return {
    agent_type: "build",
    title: "Build",
    objective: "Change one file",
    owned_scope: [{ kind: "file", path: "src/file.ts" }],
    non_goals: [],
    acceptance_criteria: [
      { id: "ac-1", condition: "Changed", requiredEvidence: "Diff" },
      { id: "ac-2", condition: "Verified", requiredEvidence: "Test output" },
    ],
    evidence: [],
    verification: [],
    depends_on: [],
    skills: [],
    background: false,
  };
}

function result(overrides: Partial<ChildResult> = {}): ChildResult {
  return {
    status: "completed",
    summary: "Done",
    deliverables: [],
    evidence: [],
    criteria: [
      { id: "ac-1", status: "passed", evidenceRefs: ["diff:1"] },
      { id: "ac-2", status: "passed", evidenceRefs: ["test:1"] },
    ],
    verification: [],
    unresolved: [],
    ...overrides,
  };
}

describe("delegation contract", () => {
  it("normalizes relative paths and rejects absolute, traversal, glob, and Windows separators", () => {
    expect(normalizeScopeRef({ kind: "tree", path: "./src/lib" })).toEqual({ kind: "tree", path: "src/lib" });
    for (const path of ["/tmp/file", "../file", "src/*.ts", "src\\file.ts"]) {
      expect(() => normalizeScopeRef({ kind: "file", path })).toThrow();
    }
  });

  it("checks existing and missing paths through the nearest existing ancestor", async () => {
    await expect(validateScopeRefInWorkspace({ kind: "file", path: "src/file.ts" }, WORKSPACE))
      .resolves.toEqual({ kind: "file", path: "src/file.ts" });
    await expect(validateScopeRefInWorkspace({ kind: "file", path: "src/missing/new.ts" }, WORKSPACE))
      .resolves.toEqual({ kind: "file", path: "src/missing/new.ts" });
  });

  it("rejects existing and missing leaves beneath an escaping symlink", async () => {
    await symlink(OUTSIDE, join(WORKSPACE, "escape"));
    await writeFile(join(OUTSIDE, "secret.ts"), "secret\n");
    await expect(validateScopeRefInWorkspace({ kind: "file", path: "escape/secret.ts" }, WORKSPACE)).rejects.toThrow("outside");
    await expect(validateScopeRefInWorkspace({ kind: "file", path: "escape/missing.ts" }, WORKSPACE)).rejects.toThrow("outside");
  });

  it("canonicalizes an in-workspace symlink alias for overlap-safe ownership", async () => {
    await symlink(join(WORKSPACE, "src"), join(WORKSPACE, "source-alias"));
    await expect(validateScopeRefInWorkspace({ kind: "file", path: "source-alias/file.ts" }, WORKSPACE))
      .resolves.toEqual({ kind: "file", path: "src/file.ts" });
    await expect(validateScopeRefInWorkspace({ kind: "file", path: "source-alias/missing.ts" }, WORKSPACE))
      .resolves.toEqual({ kind: "file", path: "src/missing.ts" });
  });

  it("detects exact and tree-ancestor overlap only", () => {
    expect(delegationScopesOverlap([{ kind: "tree", path: "src" }], [{ kind: "file", path: "src/a.ts" }])).toBe(true);
    expect(delegationScopesOverlap([{ kind: "file", path: "src/a.ts" }], [{ kind: "file", path: "src/a.ts" }])).toBe(true);
    expect(delegationScopesOverlap([{ kind: "file", path: "src/a.ts" }], [{ kind: "file", path: "src/ab.ts" }])).toBe(false);
  });

  it("hashes contracts deterministically across object key insertion order", () => {
    const value = contract();
    expect(hashDelegationContract(value)).toBe(hashDelegationContract({ ...value }));
  });

  it("requires exact criterion ids and strict completed semantics", () => {
    expect(() => validateChildResultAgainstContract(result(), contract())).not.toThrow();
    expect(() => validateChildResultAgainstContract(result({ criteria: result().criteria.slice(0, 1) }), contract())).toThrow("exactly match");
    expect(() => validateChildResultAgainstContract(result({ criteria: [
      { id: "ac-1", status: "failed", evidenceRefs: [] },
      { id: "ac-2", status: "passed", evidenceRefs: [] },
    ] }), contract())).toThrow("every criterion");
    expect(() => validateChildResultAgainstContract(result({ criteria: [
      { id: "ac-1", status: "passed", evidenceRefs: [] },
      { id: "ac-2", status: "passed", evidenceRefs: ["test:1"] },
    ] }), contract())).toThrow("evidence refs for every criterion");
    expect(() => validateChildResultAgainstContract(result({ unresolved: [
      { issue: "Need user input", blocking: true, nextOwner: "user" },
    ] }), contract())).toThrow("blocking unresolved");
  });
});
