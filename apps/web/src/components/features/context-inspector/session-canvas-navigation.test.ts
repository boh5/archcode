import { describe, expect, test } from "bun:test";
import { buildAgentFocusSearch, buildDiffSearch } from "./session-canvas-navigation";

describe("session canvas navigation", () => {
  test("focuses an agent without retaining a stale diff selection", () => {
    const search = buildAgentFocusSearch(new URLSearchParams("view=diff&file=src%2Fapp.ts"), "root", "child");
    expect(search).toBe("focus=child");
  });

  test("opens a diff without retaining a stale agent focus", () => {
    const search = buildDiffSearch(new URLSearchParams("focus=child"), "src/app.ts");
    expect(search).toBe("view=diff&file=src%2Fapp.ts");
  });
});
