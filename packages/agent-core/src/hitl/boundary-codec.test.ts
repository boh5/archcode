import { describe, expect, test } from "bun:test";

import { REDACTION_MARKER, SecretRedactionPolicy } from "../security";
import { HitlBoundaryCodec } from "./boundary-codec";

function codec(secrets: string[] = []): HitlBoundaryCodec {
  return new HitlBoundaryCodec(new SecretRedactionPolicy(secrets));
}

describe("HitlBoundaryCodec", () => {
  test("owns strict ask-user and permission blocked request unions", () => {
    const boundary = codec();
    expect(boundary.createAskUserRequest({
      toolCallId: "call-1",
      displayPayload: {
        title: "Question",
        questions: [{ question: "Continue?", header: "Decision", custom: true }],
        redacted: true,
      },
    }).source.type).toBe("ask_user");
    expect(boundary.createPermissionRequest({
      source: { type: "tool_permission", toolCallId: "call-2", toolName: "bash" },
      displayPayload: { title: "Run command", redacted: true },
      permissionFingerprint: "a".repeat(64),
      persistentApprovalEligible: true,
      permission: { description: "Run the requested command" },
    }).source.type).toBe("tool_permission");
    expect(() => boundary.createPermissionRequest({
      source: { type: "tool_permission", toolCallId: "call-2", toolName: "bash" },
      displayPayload: { title: "Run command", redacted: true },
      permissionFingerprint: "bad",
      persistentApprovalEligible: false,
      permission: { description: "Run" },
    })).toThrow();
  });

  test("redacts responses before strict validation and enforces source pairing", () => {
    const secret = "codec-secret-value-123456";
    const boundary = codec([secret]);
    const request = boundary.createAskUserRequest({
      toolCallId: "call-1",
      displayPayload: { title: "Question", redacted: true },
    });
    const response = boundary.parseResponseForRequest(request, {
      type: "question_answer",
      answers: [`Use ${secret}`],
      comment: secret,
    });
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(JSON.stringify(response)).toContain(REDACTION_MARKER);
    expect(() => boundary.parseResponseForRequest(request, {
      type: "permission_decision",
      decision: "approve_once",
    })).toThrow("does not answer ask_user");
  });

  test("rejects unknown fields and every locked byte/count limit", () => {
    const boundary = codec();
    expect(() => boundary.parseResponse({ type: "question_answer", answers: ["yes"], extra: true })).toThrow();
    expect(() => boundary.parseResponse({ type: "question_answer", answers: Array(4).fill("yes") })).toThrow();
    expect(() => boundary.parseResponse({ type: "question_answer", answers: ["ordinary words ".repeat(1400)] })).toThrow();
    expect(() => boundary.createAskUserRequest({
      toolCallId: "call-1",
      displayPayload: {
        title: "Question",
        questions: Array.from({ length: 4 }, () => ({ question: "Continue?", header: "Decision", custom: true })),
        redacted: true,
      },
    })).toThrow();
  });

  test("owns deterministic tool request keys and strict call binding", () => {
    const boundary = codec();
    const request = boundary.createAskUserRequest({
      toolCallId: "call-1",
      displayPayload: { title: "Question", redacted: true },
    });
    const input = {
      sessionId: "session-1",
      toolCallId: "call-1",
      toolName: "ask_user",
      request,
    };
    const first = boundary.createToolRequestKey(input);
    const second = boundary.createToolRequestKey(input);
    expect(first).toBe(second);
    expect(first).toMatch(/^tool:[a-f0-9]{64}$/);
    expect(() => boundary.assertToolRequestKey({ ...input, requestKey: first })).not.toThrow();
    expect(() => boundary.assertToolRequestKey({ ...input, requestKey: "tool:wrong" })).toThrow();
    expect(() => boundary.createToolRequestKey({ ...input, toolName: "bash" })).toThrow();
  });

  test("redacts and bounds delivery failures without retaining stacks", () => {
    const secret = "delivery-secret-value-123456";
    const boundary = codec([secret]);
    const error = new Error(`${secret}:${"x".repeat(4 * 1024)}`);
    error.name = `Delivery${secret}`;
    (error as Error & { code: string }).code = `CODE_${secret}`;
    const failure = boundary.redactFailure(error);
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(JSON.stringify(failure)).toContain(REDACTION_MARKER);
    expect(new TextEncoder().encode(failure.name).byteLength).toBeLessThanOrEqual(128);
    expect(new TextEncoder().encode(failure.code).byteLength).toBeLessThanOrEqual(128);
    expect(new TextEncoder().encode(failure.message).byteLength).toBeLessThanOrEqual(2 * 1024);
    expect(failure).not.toHaveProperty("stack");
  });
});
