import { describe, expect, mock, test } from "bun:test";
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

  test("converts non-ServerError to a safe 500 envelope and logs the error", async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.get("/boom", () => {
      throw new Error("secret stack detail");
    });

    const spy = mock((..._args: unknown[]) => {});
    const original = console.error;
    console.error = spy;

    const res = await app.request("/boom");

    console.error = original;

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((spy.mock.calls[0][0] as Error).message).toBe("secret stack detail");
  });
});
