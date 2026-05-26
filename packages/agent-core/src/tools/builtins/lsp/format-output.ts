import type { LspDiagnostic, LspLocation, LspSymbol } from "../../../lsp";

export function formatDiagnostics(diagnostics: LspDiagnostic[], filePath: string): string {
  if (diagnostics.length === 0) return "No diagnostics found.";

  const lines = diagnostics.map((d) => {
    const code = d.code ? ` ${d.code}` : "";
    return `${filePath}:${d.line}:${d.column} ${d.severity}${code}: ${d.message}`;
  });

  return `Diagnostics: ${lines.join("\n")}`;
}

export function formatDefinition(locations: LspLocation[]): string {
  if (locations.length === 0) return "No definitions found.";

  const lines = locations.map((l) => `${l.filePath}:${l.line}:${l.column}`);
  return `Definition: ${lines.join("\n")}`;
}

export function formatReferences(locations: LspLocation[]): string {
  if (locations.length === 0) return "No references found.";

  const parts = locations.map((l) => `${l.filePath}:${l.line}:${l.column}`);
  return `References: ${parts.join(", ")}`;
}

export function formatDocumentSymbols(symbols: LspSymbol[]): string {
  if (symbols.length === 0) return "No symbols found.";

  const parts = symbols.map((s) => `${s.kind} ${s.name} (${s.filePath}:${s.line}:${s.column})`);
  return `Symbols: ${parts.join(", ")}`;
}

export function formatWorkspaceSymbols(symbols: LspSymbol[]): string {
  if (symbols.length === 0) return "No symbols found.";

  const parts = symbols.map((s) => `${s.kind} ${s.name} (${s.filePath}:${s.line}:${s.column})`);
  return `Symbols: ${parts.join(", ")}`;
}

export function formatTimeout(toolLabel: string, timeoutMs: number): string {
  return `${toolLabel} timed out after ${timeoutMs}ms; showing last known diagnostics.`;
}
