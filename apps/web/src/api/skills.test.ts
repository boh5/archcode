import { afterEach, describe, expect, mock, test } from "bun:test";
import { getCompleteProjectSkillInventory, getCompleteProjectSkillInventoryView } from "./skills";

const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

describe("project Skill inventory", () => {
  test("traverses every cursor page and marks prompt-omitted winners", async () => {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "" } });
    const promptProjection = {
      includedEntries: [{ name: "included", description: "In prompt", source: "builtin" as const }],
      omittedCount: 1,
      renderedText: "skills",
      byteLength: 6,
    };
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/demo/skills") return Response.json({
        items: [{ name: "invalid", source: "project-archcode", winner: true, shadowed: false, valid: false, diagnostic: { code: "SKILL_INVALID_PACKAGE", message: "bad" } }],
        nextCursor: "page-2",
        promptProjection,
      });
      expect(url).toBe("/api/projects/demo/skills?cursor=page-2");
      return Response.json({
        items: [
          { name: "included", source: "builtin", winner: true, shadowed: false, valid: true, description: "In prompt" },
          { name: "omitted", source: "builtin", winner: true, shadowed: false, valid: true, description: "Not in prompt" },
          { name: "included", source: "user-agents", winner: false, shadowed: true, valid: true },
        ],
        promptProjection,
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const view = await getCompleteProjectSkillInventoryView("demo");

    expect(view.items.map((item) => [item.name, item.valid, item.shadowed, item.promptOmitted])).toEqual([
      ["invalid", false, false, false],
      ["included", true, false, false],
      ["omitted", true, false, true],
      ["included", true, true, false],
    ]);
    expect(view.promptProjection).toEqual(promptProjection);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("rejects a repeated cursor instead of looping forever", async () => {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "" } });
    globalThis.fetch = mock(async () => Response.json({
      items: [],
      nextCursor: "same",
      promptProjection: { includedEntries: [], omittedCount: 0, renderedText: "", byteLength: 0 },
    })) as unknown as typeof fetch;

    await expect(getCompleteProjectSkillInventory("demo")).rejects.toThrow("repeated cursor");
  });

  test("keeps Settings project-scoped and sends the Session id through every Composer page", async () => {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "" } });
    const urls: string[] = [];
    const promptProjection = { includedEntries: [], omittedCount: 0, renderedText: "", byteLength: 0 };
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url === "/api/projects/demo/skills?sessionId=session%2Fone") {
        return Response.json({ items: [], nextCursor: "page/2", promptProjection });
      }
      return Response.json({ items: [], promptProjection });
    }) as unknown as typeof fetch;

    await getCompleteProjectSkillInventoryView("demo");
    await getCompleteProjectSkillInventory("demo", "session/one");

    expect(urls).toEqual([
      "/api/projects/demo/skills",
      "/api/projects/demo/skills?sessionId=session%2Fone",
      "/api/projects/demo/skills?cursor=page%2F2&sessionId=session%2Fone",
    ]);
  });
});
