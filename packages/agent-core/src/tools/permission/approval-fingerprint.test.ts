import { describe, expect, test } from "bun:test";
import { approvalFingerprint } from "./approval-fingerprint";

describe("approvalFingerprint", () => {
  test("is stable across object key order and changes with exact Bash scope", () => {
    const left = { kind: "bash-exact", command: "cat /tmp/a", cwd: "/workspace", accesses: [{ path: "/tmp/a", operation: "read" }] };
    const reordered = { accesses: [{ operation: "read", path: "/tmp/a" }], cwd: "/workspace", command: "cat /tmp/a", kind: "bash-exact" };
    const changed = { ...left, cwd: "/workspace/subdir" };

    expect(approvalFingerprint(left)).toBe(approvalFingerprint(reordered));
    expect(approvalFingerprint(left)).toMatch(/^[a-f0-9]{64}$/);
    expect(approvalFingerprint(changed)).not.toBe(approvalFingerprint(left));
  });
});
