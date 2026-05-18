import { describe, expect, test } from "bun:test";
import {
  BadRequestError,
  PermissionTimeoutError,
  ProjectNotFoundError,
  ServerError,
  SessionNotFoundError,
  UnauthorizedError,
} from "./errors";

describe("ServerError", () => {
  test("stores code, message, status, and details", () => {
    const details = { field: "name" };
    const error = new ServerError("BAD_REQUEST", "Invalid input", 400, details);

    expect(error.name).toBe("ServerError");
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toBe("Invalid input");
    expect(error.httpStatus).toBe(400);
    expect(error.details).toBe(details);
  });

  test("ProjectNotFoundError has the expected contract", () => {
    const error = new ProjectNotFoundError("demo");

    expect(error.name).toBe("ProjectNotFoundError");
    expect(error.code).toBe("PROJECT_NOT_FOUND");
    expect(error.httpStatus).toBe(404);
    expect(error.message).toBe("Project not found: demo");
  });

  test("SessionNotFoundError has the expected contract", () => {
    const error = new SessionNotFoundError("session-1");

    expect(error.name).toBe("SessionNotFoundError");
    expect(error.code).toBe("SESSION_NOT_FOUND");
    expect(error.httpStatus).toBe(404);
    expect(error.message).toBe("Session not found: session-1");
  });

  test("PermissionTimeoutError has the expected contract", () => {
    const error = new PermissionTimeoutError("Permission request timed out");

    expect(error.name).toBe("PermissionTimeoutError");
    expect(error.code).toBe("PERMISSION_TIMEOUT");
    expect(error.httpStatus).toBe(408);
    expect(error.message).toBe("Permission request timed out");
  });

  test("BadRequestError has the expected contract", () => {
    const details = { reason: "missing" };
    const error = new BadRequestError("Missing required field", details);

    expect(error.name).toBe("BadRequestError");
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.httpStatus).toBe(400);
    expect(error.message).toBe("Missing required field");
    expect(error.details).toBe(details);
  });

  test("UnauthorizedError has the expected contract", () => {
    const error = new UnauthorizedError();

    expect(error.name).toBe("UnauthorizedError");
    expect(error.code).toBe("UNAUTHORIZED");
    expect(error.httpStatus).toBe(401);
    expect(error.message).toBe("Unauthorized");
  });
});
