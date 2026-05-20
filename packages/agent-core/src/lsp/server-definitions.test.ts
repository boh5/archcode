import { describe, it, expect } from "bun:test";
import {
  BUILTIN_SERVER_DEFINITIONS,
  getServerDefinitionById,
  getServerDefinitionsForLanguage,
  type LspServerDefinition,
} from "./server-definitions";

describe("BUILTIN_SERVER_DEFINITIONS", () => {
  it("contains at least 20 entries", () => {
    expect(BUILTIN_SERVER_DEFINITIONS.length).toBeGreaterThanOrEqual(20);
  });

  it.each(BUILTIN_SERVER_DEFINITIONS)(
    "$id has all required fields",
    (def: LspServerDefinition) => {
      expect(def.id).toBeTruthy();
      expect(Array.isArray(def.languageIds)).toBe(true);
      expect(def.languageIds.length).toBeGreaterThan(0);
      expect(Array.isArray(def.extensions)).toBe(true);
      expect(def.extensions.length).toBeGreaterThan(0);
      expect(Array.isArray(def.command)).toBe(true);
      expect(def.command.length).toBeGreaterThan(0);
    },
  );

  it("no two definitions share the same id", () => {
    const ids = BUILTIN_SERVER_DEFINITIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("typescript definition has npmPackage", () => {
    const ts = BUILTIN_SERVER_DEFINITIONS.find((d) => d.id === "typescript")!;
    expect(ts.npmPackage).toBe("typescript-language-server");
    expect(ts.languageIds).toContain("typescript");
    expect(ts.languageIds).toContain("javascript");
    expect(ts.extensions).toContain(".ts");
    expect(ts.extensions).toContain(".tsx");
    expect(ts.extensions).toContain(".js");
    expect(ts.command).toEqual(["typescript-language-server", "--stdio"]);
  });

  it("python server uses pyright and has npmPackage", () => {
    const py = BUILTIN_SERVER_DEFINITIONS.find((d) => d.id === "python")!;
    expect(py.npmPackage).toBe("pyright");
    expect(py.extensions).toContain(".py");
  });

  it("go and rust servers have no npmPackage (PATH-only)", () => {
    const go = BUILTIN_SERVER_DEFINITIONS.find((d) => d.id === "go")!;
    const rust = BUILTIN_SERVER_DEFINITIONS.find((d) => d.id === "rust")!;
    expect(go.npmPackage).toBeUndefined();
    expect(rust.npmPackage).toBeUndefined();
  });
});

describe("getServerDefinitionById", () => {
  it("returns the correct definition for a known id", () => {
    const def = getServerDefinitionById("typescript");
    expect(def).toBeDefined();
    expect(def!.id).toBe("typescript");
  });

  it("returns undefined for an unknown id", () => {
    expect(getServerDefinitionById("nonexistent")).toBeUndefined();
  });

  it("is case-sensitive", () => {
    expect(getServerDefinitionById("TypeScript")).toBeUndefined();
  });
});

describe("getServerDefinitionsForLanguage", () => {
  it("returns TypeScript server for 'typescript' language", () => {
    const defs = getServerDefinitionsForLanguage("typescript");
    expect(defs.length).toBeGreaterThan(0);
    expect(defs.map((d) => d.id)).toContain("typescript");
  });

  it("returns multiple servers when applicable", () => {
    const cDefs = getServerDefinitionsForLanguage("c");
    const cppDefs = getServerDefinitionsForLanguage("cpp");
    // Both map to clangd, but separately
    expect(cDefs.some((d) => d.id === "c")).toBe(true);
    expect(cppDefs.some((d) => d.id === "cpp")).toBe(true);
  });

  it("returns empty array for unknown language", () => {
    expect(getServerDefinitionsForLanguage("unknown-lang")).toEqual([]);
  });
});
