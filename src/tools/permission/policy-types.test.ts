import { describe, expect, test } from "bun:test";
import type { PermissionDecision } from "../types";
import { combinePermissionDecisions } from "./decision";
import type {
  NormalizedShellInvocation,
  NormalizedShellRequest,
  PermissionApprovalRequest,
  PermissionApprovalScope,
  ShellEffect,
  ShellEffectKind,
  ShellPathReference,
  ShellRedirection,
  ShellUncertainty,
} from "./policy-types";

describe("permission policy types", () => {
  test("defines all approval scope variants", () => {
    const scopes: PermissionApprovalScope[] = [
      { kind: "tool-operation", toolName: "file_write", operation: "write", target: "README.md" },
      { kind: "file-path", operation: "edit", path: "src/main.ts", pathMode: "exact" },
      {
        kind: "bash-command",
        command: "bun",
        subcommands: ["test"],
        argumentMode: "any",
        effects: ["execute-code"],
      },
      { kind: "bash-exact", normalized: "git status --short", effects: ["read"] },
      { kind: "web-origin", origin: "https://example.com" },
    ];

    expect(scopes.map((scope) => scope.kind)).toEqual([
      "tool-operation",
      "file-path",
      "bash-command",
      "bash-exact",
      "web-origin",
    ]);
  });

  test("defines normalized shell request model", () => {
    const effectKind: ShellEffectKind = "write";
    const redirection: ShellRedirection = {
      kind: "stdout",
      operation: "append",
      target: "logs/build.log",
      fd: 1,
    };
    const path: ShellPathReference = {
      path: "logs/build.log",
      operation: "write",
      source: "redirection",
    };
    const effect: ShellEffect = {
      kind: effectKind,
      target: "logs/build.log",
      reason: "stdout append redirection",
    };
    const uncertainty: ShellUncertainty = {
      kind: "expansion",
      reason: "contains shell variable",
      token: "$LOG_FILE",
    };
    const invocation: NormalizedShellInvocation = {
      command: "bun",
      argv: ["bun", "test"],
      cwd: "/workspace",
      segmentIndex: 0,
      separatorBefore: "&&",
      redirections: [redirection],
      paths: [path],
      effects: [effect],
      uncertainty: [uncertainty],
      display: "bun test >> logs/build.log",
    };
    const request: NormalizedShellRequest = {
      raw: "bun test >> logs/build.log",
      cwd: "/workspace",
      invocations: [invocation],
      effects: [effect],
      uncertainty: [uncertainty],
      display: "bun test >> logs/build.log",
    };

    expect(request.invocations[0]?.redirections[0]).toEqual(redirection);
    expect(request.effects[0]?.kind).toBe("write");
  });
});

describe("PermissionDecision approval compatibility", () => {
  test("keeps legacy combine priority deny > ask > allow", () => {
    const allow: PermissionDecision = { outcome: "allow" };
    const ask: PermissionDecision = { outcome: "ask", reason: "confirm" };
    const deny: PermissionDecision = { outcome: "deny", reason: "blocked" };

    expect(combinePermissionDecisions([allow, ask])).toEqual(ask);
    expect(combinePermissionDecisions([ask, allow])).toEqual(ask);
    expect(combinePermissionDecisions([allow, deny, ask])).toEqual(deny);
    expect(combinePermissionDecisions([ask, deny, allow])).toEqual(deny);
    expect(combinePermissionDecisions([allow])).toEqual({ outcome: "allow" });
  });

  test("new PermissionDecision fields are optional for legacy callers", () => {
    const decisions: PermissionDecision[] = [
      { outcome: "allow" },
      { outcome: "ask" },
      { outcome: "deny", reason: "legacy deny" },
    ];

    expect(decisions.map((decision) => decision.outcome)).toEqual(["allow", "ask", "deny"]);
  });

  test("preserves approval-aware ask metadata when ask wins", () => {
    const approval: PermissionApprovalRequest = {
      eligible: true,
      scope: {
        kind: "file-path",
        operation: "write",
        path: "/workspace/src/main.ts",
        pathMode: "exact",
      },
      display: "Write src/main.ts",
      reason: "File write requires approval",
    };
    const ask: PermissionDecision = {
      outcome: "ask",
      reason: "File write requires approval",
      approval,
      source: "builtin-policy",
      ruleId: "file-write",
      display: "Write src/main.ts",
    };

    expect(combinePermissionDecisions([{ outcome: "allow" }, ask])).toEqual(ask);
  });
});
