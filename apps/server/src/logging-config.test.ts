import { describe, expect, test } from "bun:test";
import {
  InvalidLoggingConfigurationError,
  resolveLoggingConfig,
} from "./logging-config";

describe("resolveLoggingConfig", () => {
  test("defaults to info with access logging enabled", () => {
    expect(resolveLoggingConfig({})).toEqual({
      level: "info",
      accessLog: true,
    });
  });

  test.each(["debug", "info", "warn", "error"] as const)(
    "accepts ARCHCODE_LOG_LEVEL=%s",
    (level) => {
      expect(resolveLoggingConfig({ logLevel: level })).toEqual({
        level,
        accessLog: true,
      });
    },
  );

  test.each([
    ["on", true],
    ["off", false],
  ] as const)("accepts ARCHCODE_ACCESS_LOG=%s", (accessLog, expected) => {
    expect(resolveLoggingConfig({ accessLog })).toEqual({
      level: "info",
      accessLog: expected,
    });
  });

  test.each([
    [{ logLevel: "verbose" }, "ARCHCODE_LOG_LEVEL", "verbose"],
    [{ logLevel: "" }, "ARCHCODE_LOG_LEVEL", ""],
    [{ accessLog: "true" }, "ARCHCODE_ACCESS_LOG", "true"],
    [{ accessLog: "" }, "ARCHCODE_ACCESS_LOG", ""],
  ] as const)("rejects invalid logging configuration %j", (input, name, value) => {
    expect(() => resolveLoggingConfig(input)).toThrow(
      new InvalidLoggingConfigurationError(name, value),
    );
    expect(() => resolveLoggingConfig(input)).toThrow(
      expect.objectContaining({
        name: "InvalidLoggingConfigurationError",
        code: "INVALID_LOGGING_CONFIGURATION",
        environmentVariable: name,
        value,
      }),
    );
  });
});
