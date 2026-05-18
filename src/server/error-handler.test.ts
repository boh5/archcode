import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { BadRequestError } from "./errors";
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

  test("converts non-ServerError to a safe 500 envelope", async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.get("/boom", () => {
      throw new Error("secret stack detail");
    });

    const res = await app.request("/boom");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
  });
});
