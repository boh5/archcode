import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

const indexHtml = await Bun.file(new URL("../index.html", import.meta.url)).text();
const parsed = new JSDOM(indexHtml);
const bootstrapScript = parsed.window.document.head.querySelector("script[data-theme-bootstrap]");
const bootstrapSource = bootstrapScript?.textContent ?? "";

function runBootstrap(input: { storedTheme?: string; prefersDark: boolean }): string | undefined {
  let appliedTheme: string | undefined;
  const bootstrap = new Function("window", "document", bootstrapSource);
  bootstrap({
    localStorage: { getItem: () => input.storedTheme ?? null },
    matchMedia: () => ({ matches: input.prefersDark }),
  }, {
    documentElement: { setAttribute: (_name: string, value: string) => { appliedTheme = value; } },
  });
  return appliedTheme;
}

describe("pre-React theme bootstrap", () => {
  test("applies a saved light theme while the document head is parsed", () => {
    expect(bootstrapScript?.parentElement).toBe(parsed.window.document.head);
    expect(bootstrapScript?.getAttribute("type")).toBeNull();
    expect(runBootstrap({ storedTheme: "light", prefersDark: true })).toBe("light");
  });

  test("uses the system preference when storage has no valid theme", () => {
    expect(runBootstrap({ storedTheme: "invalid", prefersDark: true })).toBe("dark");
  });
});
