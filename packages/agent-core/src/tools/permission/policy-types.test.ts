import { describe, expect, test } from "bun:test";
import type { PermissionDecision } from "../types";
import { combinePermissionDecisions } from "./decision";
import type {
  PermissionApprovalRequest,
  PermissionApprovalScope,
} from "./policy-types";

describe("permission policy types", () => {
  test("defines all approval scope variants", () => {
    const scopes: PermissionApprovalScope[] = [
      { kind: "tool-operation", toolName: "file_write", operation: "write", target: "README.md" },
      { kind: "file-path", operation: "edit", path: "src/main.ts", pathMode: "exact" },
      { kind: "bash-exact", command: "git status --short", cwd: "/workspace", accesses: [] },
      { kind: "web-origin", origin: "https://example.com" },
    ];

    expect(scopes.map((scope) => scope.kind)).toEqual([
      "tool-operation",
      "file-path",
      "bash-exact",
      "web-origin",
    ]);
  });

});

describe("PermissionDecision approval policy", () => {
  test("combines decisions with priority deny > ask > allow", () => {
    const allow: PermissionDecision = { outcome: "allow" };
    const ask: PermissionDecision = { outcome: "ask", reason: "confirm" };
    const deny: PermissionDecision = { outcome: "deny", reason: "blocked" };

    expect(combinePermissionDecisions([allow, ask])).toEqual(ask);
    expect(combinePermissionDecisions([ask, allow])).toEqual(ask);
    expect(combinePermissionDecisions([allow, deny, ask])).toEqual(deny);
    expect(combinePermissionDecisions([ask, deny, allow])).toEqual(deny);
    expect(combinePermissionDecisions([allow])).toEqual({ outcome: "allow" });
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
