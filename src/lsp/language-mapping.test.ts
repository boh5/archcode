import { describe, it, expect } from "bun:test";
import {
  getLanguageIdFromExtension,
  getLanguageIdFromFilename,
} from "./language-mapping";

describe("getLanguageIdFromExtension", () => {
  // ── TypeScript / JavaScript ──
  it.each([
    [".ts", "typescript"],
    [".tsx", "typescriptreact"],
    [".js", "javascript"],
    [".jsx", "javascriptreact"],
    [".mjs", "javascript"],
    [".cjs", "javascript"],
    [".mts", "typescript"],
    [".cts", "typescript"],
  ])("%s → %s", (ext, expected) => {
    expect(getLanguageIdFromExtension(ext)).toBe(expected);
  });

  // ── Python ──
  it.each([
    [".py", "python"],
    [".pyw", "python"],
  ])("%s → %s", (ext, expected) => {
    expect(getLanguageIdFromExtension(ext)).toBe(expected);
  });

  // ── Go / Rust ──
  it.each([
    [".go", "go"],
    [".rs", "rust"],
  ])("%s → %s", (ext, expected) => {
    expect(getLanguageIdFromExtension(ext)).toBe(expected);
  });

  // ── C / C++ ──
  it.each([
    [".c", "c"],
    [".h", "c"],
    [".cpp", "cpp"],
    [".cc", "cpp"],
    [".cxx", "cpp"],
    [".hpp", "cpp"],
    [".hh", "cpp"],
    [".hxx", "cpp"],
  ])("%s → %s", (ext, expected) => {
    expect(getLanguageIdFromExtension(ext)).toBe(expected);
  });

  // ── Java / C# / Ruby / PHP / Swift ──
  it.each([
    [".java", "java"],
    [".cs", "csharp"],
    [".rb", "ruby"],
    [".php", "php"],
    [".swift", "swift"],
  ])("%s → %s", (ext, expected) => {
    expect(getLanguageIdFromExtension(ext)).toBe(expected);
  });

  // ── Kotlin / Dart / Lua ──
  it.each([
    [".kt", "kotlin"],
    [".kts", "kotlin"],
    [".dart", "dart"],
    [".lua", "lua"],
  ])("%s → %s", (ext, expected) => {
    expect(getLanguageIdFromExtension(ext)).toBe(expected);
  });

  // ── YAML / JSON / CSS / HTML ──
  it.each([
    [".yaml", "yaml"],
    [".yml", "yaml"],
    [".json", "json"],
    [".jsonc", "jsonc"],
    [".css", "css"],
    [".scss", "scss"],
    [".less", "less"],
    [".html", "html"],
    [".htm", "html"],
  ])("%s → %s", (ext, expected) => {
    expect(getLanguageIdFromExtension(ext)).toBe(expected);
  });

  // ── Shell / GraphQL ──
  it.each([
    [".sh", "shellscript"],
    [".bash", "shellscript"],
    [".zsh", "shellscript"],
    [".graphql", "graphql"],
    [".gql", "graphql"],
    [".dockerfile", "dockerfile"],
  ])("%s → %s", (ext, expected) => {
    expect(getLanguageIdFromExtension(ext)).toBe(expected);
  });

  // ── Additional languages ──
  it.each([
    [".md", "markdown"],
    [".sql", "sql"],
    [".toml", "toml"],
    [".tf", "terraform"],
    [".ps1", "powershell"],
    [".vue", "vue"],
    [".svelte", "svelte"],
    [".zig", "zig"],
    [".gleam", "gleam"],
  ])("%s → %s", (ext, expected) => {
    expect(getLanguageIdFromExtension(ext)).toBe(expected);
  });

  // ── Edge cases ──
  it("handles extension without leading dot", () => {
    expect(getLanguageIdFromExtension("ts")).toBe("typescript");
  });

  it("returns undefined for unknown extension", () => {
    expect(getLanguageIdFromExtension(".xyz")).toBeUndefined();
    expect(getLanguageIdFromExtension("unknown")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(getLanguageIdFromExtension("")).toBeUndefined();
  });

  it("returns undefined for extension with multiple dots", () => {
    // "tar.gz" is not a known key — only the last segment matters
    expect(getLanguageIdFromExtension(".tar.gz")).toBeUndefined();
  });
});

describe("getLanguageIdFromFilename", () => {
  it("resolves from a full filename", () => {
    expect(getLanguageIdFromFilename("main.ts")).toBe("typescript");
    expect(getLanguageIdFromFilename("App.tsx")).toBe("typescriptreact");
    expect(getLanguageIdFromFilename("server.js")).toBe("javascript");
  });

  it("resolves from a file path", () => {
    expect(getLanguageIdFromFilename("src/components/App.tsx")).toBe(
      "typescriptreact",
    );
    expect(getLanguageIdFromFilename("/absolute/path/main.py")).toBe("python");
  });

  it("handles Dockerfile", () => {
    expect(getLanguageIdFromFilename("Dockerfile")).toBe("dockerfile");
    expect(getLanguageIdFromFilename("dockerfile")).toBe("dockerfile");
    expect(getLanguageIdFromFilename("path/to/Dockerfile")).toBe("dockerfile");
  });

  it("returns undefined for filenames without extension", () => {
    expect(getLanguageIdFromFilename("Makefile")).toBeUndefined();
    expect(getLanguageIdFromFilename("README")).toBeUndefined();
  });

  it("returns undefined for unknown extension", () => {
    expect(getLanguageIdFromFilename("file.xyz")).toBeUndefined();
  });
});
