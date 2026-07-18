import { describe, expect, it } from "bun:test";
import { REDACTION_MARKER, redactString, redactValue } from "./redaction";
import { containsSecretPattern } from "./patterns";

const RAW_SECRET = "sk_test_1234567890abcdef";

describe("redaction primitives", () => {
  it("uses the fixed redaction marker", () => {
    expect(REDACTION_MARKER).toBe("[REDACTED:SECRET]");
  });

  it("redacts secret-like strings via redactString", () => {
    expect(redactString(`token=${RAW_SECRET}`)).toBe(`token=${REDACTION_MARKER}`);
  });

  it("redacts slash-containing tokens whenever the detector matches", () => {
    const detectedToken = "AAAAAAAAAAAAAAA/AAAAAAAAAAAAAAAA";
    expect(containsSecretPattern(detectedToken)).toEqual({ found: true, patterns: ["token"] });
    expect(redactString(`sudo echo ${detectedToken}`)).toBe(`sudo echo ${REDACTION_MARKER}`);
  });

  it("redacts sensitive object keys via redactValue", () => {
    expect(redactValue({ token: RAW_SECRET, nested: { command: `echo ${RAW_SECRET}` } })).toEqual({
      token: REDACTION_MARKER,
      nested: { command: `echo ${REDACTION_MARKER}` },
    });
  });

  it("preserves recognized absolute paths without weakening conservative detection", () => {
    const detectorPositivePath =
      "Symbols: Interface Agent (/Users/bo/Developer/AI/archcode/src/agents/engineer-agent.ts:19:1)";
    expect(containsSecretPattern(detectorPositivePath).found).toBe(true);
    expect(redactString(detectorPositivePath)).toBe(detectorPositivePath);

    const temporaryPath = "/private/var/folders/ab/cd/T/archcode-bash-cwd-fixture";
    expect(containsSecretPattern(temporaryPath).found).toBe(true);
    expect(redactString(temporaryPath)).toBe(temporaryPath);

    expect(redactString("path=/home/user/project/src/secret-handler.ts:42:5")).toBe(
      "path=/home/user/project/src/secret-handler.ts:42:5",
    );

    expect(redactString("secret=abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGH")).toBe(
      `secret=${REDACTION_MARKER}`,
    );

    expect(redactString("api_key=sk_abc123def456ghi789jkl012mno345pqr678")).toBe(
      `api_key=${REDACTION_MARKER}`,
    );
  });
});
