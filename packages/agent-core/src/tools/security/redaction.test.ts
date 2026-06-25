import { describe, expect, it } from "bun:test";
import { REDACTION_MARKER, redactString, redactValue } from "./redaction";

const RAW_SECRET = "sk_test_1234567890abcdef";

describe("redaction primitives", () => {
  it("uses the fixed redaction marker", () => {
    expect(REDACTION_MARKER).toBe("[REDACTED:SECRET]");
  });

  it("redacts secret-like strings via redactString", () => {
    expect(redactString(`token=${RAW_SECRET}`)).toBe(`token=${REDACTION_MARKER}`);
  });

  it("redacts sensitive object keys via redactValue", () => {
    expect(redactValue({ token: RAW_SECRET, nested: { command: `echo ${RAW_SECRET}` } })).toEqual({
      token: REDACTION_MARKER,
      nested: { command: `echo ${REDACTION_MARKER}` },
    });
  });

  it("does not redact file paths that resemble base64 tokens", () => {
    expect(
      redactString(
        "Symbols: Interface Agent (/Users/bo/Developer/AI/archcode/src/agents/orchestrator-agent.ts:19:1)",
      ),
    ).toBe(
      "Symbols: Interface Agent (/Users/bo/Developer/AI/archcode/src/agents/orchestrator-agent.ts:19:1)",
    );

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
