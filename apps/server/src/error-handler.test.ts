import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createInMemoryLogger } from "@archcode/agent-core";
import { BadRequestError, ServerError } from "./errors";
import { errorHandler } from "./error-handler";

describe("errorHandler", () => {
  test("converts ServerError to the JSON error envelope", async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.get("/bad-request", () => {
      throw new BadRequestError("Invalid request", { field: "slug" });
    });

    const res = await app.request("/bad-request");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "Invalid request",
        details: { field: "slug" },
      },
    });
  });

  test("converts non-ServerError to a safe 500 envelope and logs the error", async () => {
    const { logger, entries } = createInMemoryLogger();
    const app = new Hono();
    app.onError((error, context) => errorHandler(error, context, logger));
    app.get("/boom", () => {
      throw new Error("secret stack detail");
    });

    const res = await app.request("/boom");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: "error",
      event: "http.request.failed",
      error: {
        name: "Error",
        message: "secret stack detail",
      },
    });
  });

  test("logs a controlled 500 even when access logging is handled elsewhere", async () => {
    const { logger, entries } = createInMemoryLogger();
    const app = new Hono();
    app.onError((error, context) => errorHandler(error, context, logger));
    app.get("/controlled", () => {
      throw new ServerError("INTERNAL_ERROR", "Controlled failure", 500);
    });

    const res = await app.request("/controlled");

    expect(res.status).toBe(500);
    expect(entries).toContainEqual(expect.objectContaining({
      level: "error",
      event: "http.request.failed",
      context: {
        method: "GET",
        path: "/controlled",
        status: 500,
      },
      meta: {
        errorName: "ServerError",
        errorCode: "INTERNAL_ERROR",
      },
    }));
  });
});
