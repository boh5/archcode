import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod/v4";

import { errorHandler } from "./error-handler";
import { zValidator } from "./validation";

function createApp(): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.post(
    "/items/:itemId",
    zValidator("param", z.strictObject({ itemId: z.uuid() })),
    zValidator("query", z.strictObject({ mode: z.enum(["safe", "fast"]) })),
    zValidator("json", z.strictObject({ name: z.string().trim().min(1) })),
    (c) => c.json({
      itemId: c.req.valid("param").itemId,
      mode: c.req.valid("query").mode,
      name: c.req.valid("json").name,
    }),
  );
  return app;
}

describe("zValidator", () => {
  test("stores validated param, query, and JSON values", async () => {
    const app = createApp();
    const itemId = crypto.randomUUID();
    const response = await app.request(`/items/${itemId}?mode=safe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "  Item  " }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ itemId, mode: "safe", name: "Item" });
  });

  test("converts Zod failures to the existing bad request envelope", async () => {
    const response = await createApp().request("/items/not-a-uuid?mode=unknown", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Item" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  test("rejects invalid query enums and a missing required JSON body", async () => {
    const app = createApp();
    const itemId = crypto.randomUUID();
    const invalidQuery = await app.request(`/items/${itemId}?mode=unknown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Item" }),
    });
    const missingBody = await app.request(`/items/${itemId}?mode=safe`, { method: "POST" });

    expect(invalidQuery.status).toBe(400);
    expect(await invalidQuery.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(missingBody.status).toBe(400);
    expect(await missingBody.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  test("keeps malformed JSON as a 400 bad request envelope", async () => {
    const response = await createApp().request(`/items/${crypto.randomUUID()}?mode=safe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "Malformed JSON in request body" },
    });
  });
});
