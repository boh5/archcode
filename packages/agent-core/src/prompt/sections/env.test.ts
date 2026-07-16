import { describe, expect, test } from "bun:test";
import { buildEnvSection } from "./env";

describe("buildEnvSection", () => {
  test("includes platform", () => {
    const result = buildEnvSection({
      platform: "darwin",
      timezone: "America/Los_Angeles",
      locale: "en-US",
      projectRoot: "/home/user/project",
      cwd: "/home/user/project",
      versionControl: "git",
      date: "2025-01-15",
    });
    expect(result).toContain("Platform: darwin");
  });

  test("includes timezone", () => {
    const result = buildEnvSection({
      platform: "linux",
      timezone: "Europe/Berlin",
      locale: "de-DE",
      projectRoot: "/home/user/project",
      cwd: "/home/user/project",
      versionControl: "git",
      date: "2025-06-01",
    });
    expect(result).toContain("Timezone: Europe/Berlin");
  });

  test("includes locale", () => {
    const result = buildEnvSection({
      platform: "darwin",
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      projectRoot: "/Users/bo/project",
      cwd: "/Users/bo/project",
      versionControl: "git",
      date: "2025-03-10",
    });
    expect(result).toContain("Locale: zh-CN");
  });

  test("includes cwd", () => {
    const result = buildEnvSection({
      platform: "darwin",
      timezone: "UTC",
      locale: "en-US",
      projectRoot: "/special/path",
      cwd: "/special/path",
      versionControl: "git",
      date: "2025-01-01",
    });
    expect(result).toContain("Working directory: /special/path");
  });

  test("distinguishes canonical project state from a worktree execution directory", () => {
    const result = buildEnvSection({
      platform: "darwin",
      timezone: "UTC",
      locale: "en-US",
      projectRoot: "/repo",
      cwd: "/repo.worktrees/session-1",
      versionControl: "git",
      date: "2025-01-01",
    });

    expect(result).toContain("Project root: /repo");
    expect(result).toContain("Working directory: /repo.worktrees/session-1");
    expect(result).toContain("Execution mode: worktree");
    expect(result).toContain("not an operating-system sandbox");
    expect(result).toContain(
      "Filesystem, shell, Skill, and LSP tool paths resolve from and are scoped to the working directory.",
    );
    expect(result).toContain("Git tool and command paths resolve from the working directory.");
    expect(result).toContain("Change Session worktrees only when the user explicitly asks.");
    expect(result).toContain("Do not enumerate other worktrees.");
    expect(result).toContain("Never invoke Git worktree commands or edit Git metadata directly through shell/file tools.");
  });

  test("includes date", () => {
    const result = buildEnvSection({
      platform: "win32",
      timezone: "UTC",
      locale: "en-US",
      projectRoot: "C:\\Users",
      cwd: "C:\\Users",
      versionControl: "git",
      date: "2025-12-25",
    });
    expect(result).toContain("Date: 2025-12-25");
  });

  test("contains 'Environment' header", () => {
    const result = buildEnvSection({
      platform: "darwin",
      timezone: "UTC",
      locale: "en-US",
      projectRoot: "/",
      cwd: "/",
      versionControl: "git",
      date: "2025-01-01",
    });
    expect(result).toContain("## Environment");
  });

  test("forbids Git tools and commands when no repository is detected", () => {
    const result = buildEnvSection({
      platform: "darwin",
      timezone: "UTC",
      locale: "en-US",
      projectRoot: "/project",
      cwd: "/project",
      versionControl: "none",
      date: "2025-01-01",
    });

    expect(result).toContain("Version control: none");
    expect(result).toContain(
      "Git-specific instructions elsewhere in this prompt apply only when Version control is git",
    );
    expect(result).toContain("use file inspection and other non-Git evidence instead");
    expect(result).toContain("No Git repository is detected");
    expect(result).toContain("Do not call git_status, git_diff, Session worktree tools, or Git commands");
    expect(result).not.toContain("A Git repository is detected");
  });

  test("describes Git capability when a repository is detected", () => {
    const result = buildEnvSection({
      platform: "darwin",
      timezone: "UTC",
      locale: "en-US",
      projectRoot: "/repo",
      cwd: "/repo",
      versionControl: "git",
      date: "2025-01-01",
    });

    expect(result).toContain("Version control: git");
    expect(result).toContain(
      "Git-specific instructions elsewhere in this prompt apply only when Version control is git",
    );
    expect(result).toContain("A Git repository is detected");
    expect(result).not.toContain("No Git repository is detected");
  });
});
