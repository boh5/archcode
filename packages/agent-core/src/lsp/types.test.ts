import { describe, expect, test } from "bun:test";
import {
  LspDiagnosticsInputSchema,
  LspGotoDefinitionInputSchema,
  LspFindReferencesInputSchema,
  LspSymbolsInputSchema,
} from "./types";

describe("LspDiagnosticsInputSchema", () => {
  test("accepts valid input with all fields", () => {
    const result = LspDiagnosticsInputSchema.safeParse({
      filePath: "src/foo.ts",
      severity: "error",
    });
    expect(result.success).toBe(true);
  });

  test("accepts minimal input (filePath only)", () => {
    const result = LspDiagnosticsInputSchema.safeParse({
      filePath: "src/foo.ts",
    });
    expect(result.success).toBe(true);
  });

  test("rejects unknown fields", () => {
    const result = LspDiagnosticsInputSchema.safeParse({
      filePath: "src/foo.ts",
      extra: "value",
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid severity value", () => {
    const result = LspDiagnosticsInputSchema.safeParse({
      filePath: "src/foo.ts",
      severity: "critical",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing filePath", () => {
    const result = LspDiagnosticsInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("LspGotoDefinitionInputSchema", () => {
  test("accepts valid input", () => {
    const result = LspGotoDefinitionInputSchema.safeParse({
      filePath: "src/bar.ts",
      line: 10,
      character: 5,
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing line", () => {
    const result = LspGotoDefinitionInputSchema.safeParse({
      filePath: "src/bar.ts",
      character: 5,
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing character", () => {
    const result = LspGotoDefinitionInputSchema.safeParse({
      filePath: "src/bar.ts",
      line: 10,
    });
    expect(result.success).toBe(false);
  });

  test("rejects unknown fields", () => {
    const result = LspGotoDefinitionInputSchema.safeParse({
      filePath: "src/bar.ts",
      line: 10,
      character: 5,
      extra: true,
    });
    expect(result.success).toBe(false);
  });

  test("accepts line as integer", () => {
    const result = LspGotoDefinitionInputSchema.safeParse({
      filePath: "src/bar.ts",
      line: 1,
      character: 0,
    });
    expect(result.success).toBe(true);
  });
});

describe("LspFindReferencesInputSchema", () => {
  test("accepts valid input with all fields", () => {
    const result = LspFindReferencesInputSchema.safeParse({
      filePath: "src/baz.ts",
      line: 15,
      character: 3,
      includeDeclaration: true,
    });
    expect(result.success).toBe(true);
  });

  test("accepts minimal input", () => {
    const result = LspFindReferencesInputSchema.safeParse({
      filePath: "src/baz.ts",
      line: 15,
      character: 3,
    });
    expect(result.success).toBe(true);
  });

  test("includeDeclaration defaults to undefined (optional)", () => {
    const result = LspFindReferencesInputSchema.safeParse({
      filePath: "src/baz.ts",
      line: 15,
      character: 3,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.includeDeclaration).toBeUndefined();
    }
  });

  test("includeDeclaration can be false", () => {
    const result = LspFindReferencesInputSchema.safeParse({
      filePath: "src/baz.ts",
      line: 15,
      character: 3,
      includeDeclaration: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.includeDeclaration).toBe(false);
    }
  });

  test("rejects unknown fields", () => {
    const result = LspFindReferencesInputSchema.safeParse({
      filePath: "src/baz.ts",
      line: 15,
      character: 3,
      unknown: "field",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing required fields", () => {
    const result = LspFindReferencesInputSchema.safeParse({
      filePath: "src/baz.ts",
    });
    expect(result.success).toBe(false);
  });
});

describe("LspSymbolsInputSchema", () => {
  test("accepts document scope with filePath", () => {
    const result = LspSymbolsInputSchema.safeParse({
      scope: "document",
      filePath: "src/example.ts",
    });
    expect(result.success).toBe(true);
  });

  test("accepts workspace scope with query", () => {
    const result = LspSymbolsInputSchema.safeParse({
      scope: "workspace",
      query: "Example",
    });
    expect(result.success).toBe(true);
  });

  test("rejects document scope without filePath", () => {
    const result = LspSymbolsInputSchema.safeParse({
      scope: "document",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("filePath"))).toBe(true);
    }
  });

  test("rejects workspace scope without query", () => {
    const result = LspSymbolsInputSchema.safeParse({
      scope: "workspace",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("query"))).toBe(true);
    }
  });

  test("rejects unknown fields", () => {
    const result = LspSymbolsInputSchema.safeParse({
      scope: "document",
      filePath: "src/example.ts",
      extra: "value",
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid scope value", () => {
    const result = LspSymbolsInputSchema.safeParse({
      scope: "invalid",
    });
    expect(result.success).toBe(false);
  });

  test("accepts document scope with all optional fields", () => {
    const result = LspSymbolsInputSchema.safeParse({
      scope: "document",
      filePath: "src/example.ts",
      query: "Example",
    });
    expect(result.success).toBe(true);
  });

  test("accepts workspace scope with all optional fields", () => {
    const result = LspSymbolsInputSchema.safeParse({
      scope: "workspace",
      query: "Example",
      filePath: "src/example.ts",
    });
    expect(result.success).toBe(true);
  });
});
