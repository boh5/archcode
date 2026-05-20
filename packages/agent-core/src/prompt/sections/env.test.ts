import { describe, expect, test } from "bun:test";
import { buildEnvSection } from "./env";

describe("buildEnvSection", () => {
  test("includes platform", () => {
    const result = buildEnvSection({
      platform: "darwin",
      timezone: "America/Los_Angeles",
      locale: "en-US",
      cwd: "/home/user/project",
      date: "2025-01-15",
    });
    expect(result).toContain("Platform: darwin");
  });

  test("includes timezone", () => {
    const result = buildEnvSection({
      platform: "linux",
      timezone: "Europe/Berlin",
      locale: "de-DE",
      cwd: "/home/user/project",
      date: "2025-06-01",
    });
    expect(result).toContain("Timezone: Europe/Berlin");
  });

  test("includes locale", () => {
    const result = buildEnvSection({
      platform: "darwin",
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      cwd: "/Users/bo/project",
      date: "2025-03-10",
    });
    expect(result).toContain("Locale: zh-CN");
  });

  test("includes cwd", () => {
    const result = buildEnvSection({
      platform: "darwin",
      timezone: "UTC",
      locale: "en-US",
      cwd: "/special/path",
      date: "2025-01-01",
    });
    expect(result).toContain("Working directory: /special/path");
  });

  test("includes date", () => {
    const result = buildEnvSection({
      platform: "win32",
      timezone: "UTC",
      locale: "en-US",
      cwd: "C:\\Users",
      date: "2025-12-25",
    });
    expect(result).toContain("Date: 2025-12-25");
  });

  test("contains 'Environment' header", () => {
    const result = buildEnvSection({
      platform: "darwin",
      timezone: "UTC",
      locale: "en-US",
      cwd: "/",
      date: "2025-01-01",
    });
    expect(result).toContain("## Environment");
  });
});