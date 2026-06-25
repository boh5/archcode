import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCommand } from "../bash-classifier";
import { parseShellRequest } from "./parse";

const workspaceRoot = join(tmpdir(), "archcode-bash-parse-tests");

function parse(command: string) {
  return parseShellRequest(command, { workspaceRoot });
}

describe("parseShellRequest", () => {
  test("normalizes compound commands into segment invocations", () => {
    const request = parse("ls src && git status");
    expect("ok" in request).toBe(false);
    if ("ok" in request) throw new Error("unexpected parse failure");

    expect(request.display).toBe("ls src && git status");
    expect(request.invocations).toHaveLength(2);
    expect(request.invocations[0]).toMatchObject({
      command: "ls",
      argv: ["ls", "src"],
      segmentIndex: 0,
      display: "ls src",
    });
    expect(request.invocations[1]).toMatchObject({
      command: "git",
      argv: ["git", "status"],
      segmentIndex: 1,
      separatorBefore: "&&",
      display: "git status",
    });
  });

  test("records parser uncertainty for substitutions, heredocs, and unclosed quotes", () => {
    for (const command of ["echo $(whoami)", "echo `whoami`", "cat <<EOF", "echo 'unterminated"]) {
      const request = parse(command);
      expect("ok" in request).toBe(command.trim().length === 0);
      expect(request.uncertainty.length).toBeGreaterThan(0);

      const decision = classifyCommand(command, { workspaceRoot });
      expect(decision.outcome).toBe("ask");
      expect(decision.approval?.eligible).toBe(false);
    }
  });

  test("extracts write redirections", () => {
    const request = parse("echo x > file.txt");
    if ("ok" in request) throw new Error("unexpected parse failure");
    expect(request.invocations[0]?.redirections).toEqual([
      { kind: "stdout", operation: "write", target: "file.txt", fd: 1 },
    ]);
    expect(request.invocations[0]?.paths).toContainEqual({ path: "file.txt", operation: "write", source: "redirection" });
  });

  test("extracts read path references", () => {
    const request = parse("cat src/main.ts");
    if ("ok" in request) throw new Error("unexpected parse failure");
    expect(request.invocations[0]?.paths).toContainEqual({ path: "src/main.ts", operation: "read", source: "argument" });
  });

  test("marks shell -c wrappers uncertain", () => {
    const request = parse('bash -c "echo hi"');
    if ("ok" in request) throw new Error("unexpected parse failure");
    expect(request.invocations[0]?.uncertainty).toContainEqual({
      kind: "parse",
      reason: "Shell -c wrapper requires recursive review",
      token: "bash -c",
    });
    const decision = classifyCommand('bash -c "echo hi"', { workspaceRoot });
    expect(decision.outcome).toBe("ask");
    expect(decision.approval?.eligible).toBe(false);
  });

  test("keeps compound segments independent with deny winning downstream", () => {
    const request = parse("pwd ; rm -rf src || git status | tee out.txt");
    if ("ok" in request) throw new Error("unexpected parse failure");
    expect(request.invocations.map((invocation) => invocation.separatorBefore)).toEqual([undefined, ";", "||", "|"]);
    expect(request.invocations.map((invocation) => invocation.command)).toEqual(["pwd", "rm", "git", "tee"]);
    expect(classifyCommand("pwd ; rm -rf .archcode || git status | tee out.txt", { workspaceRoot }).outcome).toBe("deny");
  });
});
