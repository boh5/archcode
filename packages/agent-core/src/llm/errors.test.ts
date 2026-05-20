import { describe, expect, test } from "bun:test";

import {
  LlmMaxRetriesError,
  LlmObjectError,
  LlmSchemaValidationError,
} from "./errors";

describe("LlmObjectError", () => {
  test("has correct name", () => {
    const err = new LlmObjectError({ message: "something went wrong" });
    expect(err.name).toBe("LlmObjectError");
  });

  test("preserves message", () => {
    const err = new LlmObjectError({ message: "custom message" });
    expect(err.message).toBe("custom message");
  });
});

describe("LlmSchemaValidationError", () => {
  test("has correct name", () => {
    const err = new LlmSchemaValidationError({ message: "validation failed" });
    expect(err.name).toBe("LlmSchemaValidationError");
  });

  test("preserves cause when provided", () => {
    const cause = new Error("zod parse error");
    const err = new LlmSchemaValidationError({
      message: "validation failed",
      cause,
    });
    expect(err.cause).toBe(cause);
  });

  test("works without cause", () => {
    const err = new LlmSchemaValidationError({ message: "validation failed" });
    expect(err.cause).toBeUndefined();
  });
});

describe("LlmMaxRetriesError", () => {
  test("has correct name", () => {
    const err = new LlmMaxRetriesError({
      message: "max retries exceeded",
    });
    expect(err.name).toBe("LlmMaxRetriesError");
  });

  test("preserves cause when provided", () => {
    const cause = new Error("rate limited");
    const err = new LlmMaxRetriesError({
      message: "max retries exceeded",
      cause,
    });
    expect(err.cause).toBe(cause);
  });

  test("works without cause", () => {
    const err = new LlmMaxRetriesError({
      message: "max retries exceeded",
    });
    expect(err.cause).toBeUndefined();
  });
});
