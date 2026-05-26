import { describe, expect, test } from "bun:test";
import type { LspDiagnostic, LspLocation, LspSymbol } from "../../../lsp";
import {
  formatDiagnostics,
  formatDefinition,
  formatReferences,
  formatDocumentSymbols,
  formatWorkspaceSymbols,
  formatTimeout,
} from "./format-output";

describe("formatDiagnostics", () => {
  test("formats single diagnostic with code", () => {
    const diagnostics: LspDiagnostic[] = [
      {
        filePath: "src/foo.ts",
        line: 10,
        column: 5,
        severity: "error",
        code: "TS2322",
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ];
    const result = formatDiagnostics(diagnostics, "src/foo.ts");
    expect(result).toBe(
      "Diagnostics: src/foo.ts:10:5 error TS2322: Type 'string' is not assignable to type 'number'.",
    );
  });

  test("formats single diagnostic without code", () => {
    const diagnostics: LspDiagnostic[] = [
      {
        filePath: "src/foo.ts",
        line: 15,
        column: 1,
        severity: "warning",
        message: "Variable 'x' is never used.",
      },
    ];
    const result = formatDiagnostics(diagnostics, "src/foo.ts");
    expect(result).toBe(
      "Diagnostics: src/foo.ts:15:1 warning: Variable 'x' is never used.",
    );
  });

  test("formats multiple diagnostics", () => {
    const diagnostics: LspDiagnostic[] = [
      {
        filePath: "src/foo.ts",
        line: 10,
        column: 5,
        severity: "error",
        code: "TS2322",
        message: "Type 'string' is not assignable to type 'number'.",
      },
      {
        filePath: "src/foo.ts",
        line: 15,
        column: 1,
        severity: "warning",
        message: "Variable 'x' is never used.",
      },
    ];
    const result = formatDiagnostics(diagnostics, "src/foo.ts");
    expect(result).toBe(
      "Diagnostics: src/foo.ts:10:5 error TS2322: Type 'string' is not assignable to type 'number'.\n" +
        "src/foo.ts:15:1 warning: Variable 'x' is never used.",
    );
  });

  test("returns empty message for empty diagnostics", () => {
    const result = formatDiagnostics([], "src/foo.ts");
    expect(result).toBe("No diagnostics found.");
  });
});

describe("formatDefinition", () => {
  test("formats single definition", () => {
    const locations: LspLocation[] = [
      { filePath: "src/bar.ts", line: 15, column: 3 },
    ];
    const result = formatDefinition(locations);
    expect(result).toBe("Definition: src/bar.ts:15:3");
  });

  test("formats multiple definitions", () => {
    const locations: LspLocation[] = [
      { filePath: "src/bar.ts", line: 15, column: 3 },
      { filePath: "src/baz.ts", line: 1, column: 5 },
    ];
    const result = formatDefinition(locations);
    expect(result).toBe("Definition: src/bar.ts:15:3\nsrc/baz.ts:1:5");
  });

  test("returns empty message for empty definitions", () => {
    const result = formatDefinition([]);
    expect(result).toBe("No definitions found.");
  });
});

describe("formatReferences", () => {
  test("formats single reference", () => {
    const locations: LspLocation[] = [
      { filePath: "src/a.ts", line: 1, column: 1 },
    ];
    const result = formatReferences(locations);
    expect(result).toBe("References: src/a.ts:1:1");
  });

  test("formats multiple references", () => {
    const locations: LspLocation[] = [
      { filePath: "src/a.ts", line: 1, column: 1 },
      { filePath: "src/b.ts", line: 3, column: 5 },
    ];
    const result = formatReferences(locations);
    expect(result).toBe("References: src/a.ts:1:1, src/b.ts:3:5");
  });

  test("returns empty message for empty references", () => {
    const result = formatReferences([]);
    expect(result).toBe("No references found.");
  });
});

describe("formatDocumentSymbols", () => {
  test("formats single symbol", () => {
    const symbols: LspSymbol[] = [
      { name: "Example", kind: "class", filePath: "src/example.ts", line: 1, column: 1 },
    ];
    const result = formatDocumentSymbols(symbols);
    expect(result).toBe("Symbols: class Example (src/example.ts:1:1)");
  });

  test("formats multiple symbols", () => {
    const symbols: LspSymbol[] = [
      { name: "Example", kind: "class", filePath: "src/example.ts", line: 1, column: 1 },
      { name: "run", kind: "method", filePath: "src/example.ts", line: 2, column: 3 },
    ];
    const result = formatDocumentSymbols(symbols);
    expect(result).toBe(
      "Symbols: class Example (src/example.ts:1:1), method run (src/example.ts:2:3)",
    );
  });

  test("returns empty message for empty symbols", () => {
    const result = formatDocumentSymbols([]);
    expect(result).toBe("No symbols found.");
  });
});

describe("formatWorkspaceSymbols", () => {
  test("formats single symbol", () => {
    const symbols: LspSymbol[] = [
      { name: "Foo", kind: "function", filePath: "src/foo.ts", line: 5, column: 1 },
    ];
    const result = formatWorkspaceSymbols(symbols);
    expect(result).toBe("Symbols: function Foo (src/foo.ts:5:1)");
  });

  test("formats multiple symbols", () => {
    const symbols: LspSymbol[] = [
      { name: "Foo", kind: "function", filePath: "src/foo.ts", line: 5, column: 1 },
      { name: "Bar", kind: "variable", filePath: "src/bar.ts", line: 10, column: 3 },
    ];
    const result = formatWorkspaceSymbols(symbols);
    expect(result).toBe(
      "Symbols: function Foo (src/foo.ts:5:1), variable Bar (src/bar.ts:10:3)",
    );
  });

  test("returns empty message for empty symbols", () => {
    const result = formatWorkspaceSymbols([]);
    expect(result).toBe("No symbols found.");
  });
});

describe("formatTimeout", () => {
  test("formats timeout message with tool label and duration", () => {
    const result = formatTimeout("Diagnostics", 15000);
    expect(result).toBe("Diagnostics timed out after 15000ms; showing last known diagnostics.");
  });

  test("works with different labels and durations", () => {
    const result = formatTimeout("Symbols", 30000);
    expect(result).toBe("Symbols timed out after 30000ms; showing last known diagnostics.");
  });
});
