import { describe, expect, test } from "bun:test";
import type { SpecraRuntime } from "@specra/agent-core";
import { createServerApp } from "./app";

const mockRuntime = {} as SpecraRuntime;

describe("createServerApp", () => {
  test("returns the health endpoint response", async () => {
    const { app } = createServerApp(mockRuntime, { dev: true });

    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("adds wildcard CORS headers in dev mode", async () => {
    const { app } = createServerApp(mockRuntime, { dev: true });

    const res = await app.request("/api/health", {
      headers: { Origin: "http://localhost:5173" },
    });

    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("requires Basic auth for API routes when a password is configured", async () => {
    const { app } = createServerApp(mockRuntime, { dev: true, password: "secret" });

    const res = await app.request("/api/health");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    });
  });

  test("accepts Basic auth when the password matches", async () => {
    const { app } = createServerApp(mockRuntime, { dev: true, password: "secret" });

    const res = await app.request("/api/health", {
      headers: { Authorization: `Basic ${btoa("user:secret")}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
