import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedShellRequest, PermissionApprovalScope } from "../../permission/policy-types";
import { silentLogger } from "../../../logger";
import { ProjectApprovalManager } from "../../permission/project-approvals";
import { classifyCommand } from "../bash-classifier";
import { attachShellEffects } from "./effects";
import { parseShellRequest } from "./parse";
import { deriveShellApprovalScope } from "./scopes";

const workspaceRoot = join(tmpdir(), "archcode-bash-scopes-tests");

function requestFor(command: string): NormalizedShellRequest {
  const parsed = parseShellRequest(command, { workspaceRoot });
  if ("ok" in parsed) throw new Error(`Unexpected parse failure for ${command}`);
  return attachShellEffects(parsed);
}

function scopeFor(command: string): PermissionApprovalScope {
  return deriveShellApprovalScope(requestFor(command));
}

describe("deriveShellApprovalScope", () => {
  test("creates broad command scopes for stable read-only command families", () => {
    expect(scopeFor("git status --short")).toEqual({
      kind: "bash-command",
      command: "git",
      subcommands: ["status"],
      argumentMode: "any",
      effects: [],
    });
    expect(scopeFor("git diff --stat")).toEqual({
      kind: "bash-command",
      command: "git",
      subcommands: ["diff"],
      argumentMode: "any",
      effects: [],
    });
    expect(scopeFor("git log --oneline")).toEqual({
      kind: "bash-command",
      command: "git",
      subcommands: ["log"],
      argumentMode: "any",
      effects: [],
    });
    expect(scopeFor("bun run typecheck")).toEqual({
      kind: "bash-command",
      command: "bun",
      subcommands: ["run"],
      argumentMode: "any",
      effects: [],
    });
    expect(scopeFor("bun add zod")).toEqual({
      kind: "bash-command",
      command: "bun",
      subcommands: ["add"],
      argumentMode: "any",
      effects: [],
    });
    expect(scopeFor("npm install left-pad")).toEqual({
      kind: "bash-command",
      command: "npm",
      subcommands: ["install"],
      argumentMode: "any",
      effects: [],
    });
  });

  test("creates broad curl scopes only for ordinary GET and HEAD requests", () => {
    expect(scopeFor("curl https://example.com")).toEqual({
      kind: "bash-command",
      command: "curl",
      subcommands: ["get"],
      argumentMode: "any",
      effects: [],
    });
    expect(scopeFor("curl -I https://example.com")).toEqual({
      kind: "bash-command",
      command: "curl",
      subcommands: ["head"],
      argumentMode: "any",
      effects: [],
    });
    expect(scopeFor("curl -X POST https://example.com")).toMatchObject({
      kind: "bash-exact",
      normalized: "curl -X POST https://example.com",
    });
  });

  test("uses exact-only scopes for writes, protected paths, remote commands, and parser uncertainty", () => {
    expect(scopeFor("echo hi > out.txt")).toEqual({
      kind: "bash-exact",
      normalized: "echo hi > out.txt",
      effects: ["write"],
    });
    expect(scopeFor("git push origin main")).toEqual({
      kind: "bash-exact",
      normalized: "git push origin main",
      effects: [],
    });
    expect(scopeFor("ssh host uptime")).toEqual({
      kind: "bash-exact",
      normalized: "ssh host uptime",
      effects: ["network"],
    });
    expect(scopeFor("rm -rf .archcode/cache")).toEqual({
      kind: "bash-exact",
      normalized: "rm -rf .archcode/cache",
      effects: ["protected-path", "delete"],
    });
    expect(scopeFor("echo $(whoami)")).toEqual({
      kind: "bash-exact",
      normalized: "echo $(whoami)",
      effects: ["parser-uncertain"],
    });
  });

  test("does not allow a redirected command through an unrelated broad approval", async () => {
    const manager = new ProjectApprovalManager(silentLogger);
    await manager.load(workspaceRoot);
    await manager.addApproval({
      kind: "bash-command",
      command: "git",
      subcommands: ["status"],
      argumentMode: "any",
      effects: [],
    }, {
      display: "git status *",
      reason: "Stable read-only git status",
    });

    const redirectedScope = scopeFor("cargo check > ~/.zshrc");

    expect(redirectedScope).toEqual({
      kind: "bash-exact",
      normalized: "cargo check > ~/.zshrc",
      effects: ["write"],
    });
    expect(manager.hasApproval(redirectedScope)).toBe(false);
  });

  test("never creates a broad kill approval scope", () => {
    const decision = classifyCommand("kill -9 44165", { workspaceRoot });
    const scope = decision.approval?.scope ?? scopeFor("kill -9 44165");

    expect(scope).not.toMatchObject({ kind: "bash-command", command: "kill" });
    expect(scope).toEqual({
      kind: "bash-exact",
      normalized: "kill -9 44165",
      effects: [],
    });
  });
});
