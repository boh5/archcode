import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createInMemoryLogger } from "@archcode/agent-core";
import { requestLogger } from "./logger";

describe("requestLogger", () => {
  test.each([
    [200, "info"],
    [302, "info"],
    [400, "info"],
    [404, "info"],
    [500, "error"],
  ] as const)("records status %i at %s", async (status, level) => {
    const { logger, entries } = createInMemoryLogger();
    const app = new Hono();
    app.use("*", requestLogger(logger));
    app.get("/request", (context) => context.body(null, status));

    await app.request("/request?secret=not-logged");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level,
      event: "http.request.completed",
      context: {
        method: "GET",
        path: "/request",
        status,
        durationMs: expect.any(Number),
      },
    });
    expect(JSON.stringify(entries[0])).not.toContain("not-logged");
  });
});
