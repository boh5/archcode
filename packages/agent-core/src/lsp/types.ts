import { z } from "zod";

// ─── Shared Types ───

export type LspDiagnosticSeverity = "error" | "warning" | "information" | "hint";

export interface LspDiagnostic {
  filePath: string;
  line: number;
  column: number;
  severity: LspDiagnosticSeverity;
  message: string;
  code?: string;
}

export interface LspLocation {
  filePath: string;
  line: number;
  column: number;
}

export interface LspSymbol {
  name: string;
  kind: string;
  filePath: string;
  line: number;
  column: number;
}

// ─── Schemas ───

export const LspDiagnosticsInputSchema = z
  .object({
    filePath: z.string().describe("Absolute or workspace-relative path of the file or directory to check"),
    severity: z.enum(["error", "warning", "information", "hint", "all"]).optional()
      .describe("Filter by severity. Omit for all severities."),
  })
  .strict();

export const LspGotoDefinitionInputSchema = z
  .object({
    filePath: z.string().describe("Absolute or workspace-relative path of the source file"),
    line: z.number().describe("1-based line number of the symbol position"),
    character: z.number().describe("0-based character (column) offset within the line"),
  })
  .strict();

export const LspFindReferencesInputSchema = z
  .object({
    filePath: z.string().describe("Absolute or workspace-relative path of the source file"),
    line: z.number().describe("1-based line number of the symbol position"),
    character: z.number().describe("0-based character (column) offset within the line"),
    includeDeclaration: z.boolean().optional()
      .describe("Include the symbol's own declaration in results (default true)"),
  })
  .strict();

export const LspSymbolsInputSchema = z
  .object({
    scope: z.enum(["document", "workspace"]).describe("Search scope: \"document\" for symbols in one file, \"workspace\" for project-wide search"),
    filePath: z.string().optional().describe("Required when scope=\"document\". Absolute or workspace-relative path of the file."),
    query: z.string().optional().describe("Required when scope=\"workspace\". Symbol name (or substring) to search for."),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.scope === "document" && !data.filePath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "filePath is required when scope is 'document'",
        path: ["filePath"],
      });
    }
    if (data.scope === "workspace" && !data.query) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "query is required when scope is 'workspace'",
        path: ["query"],
      });
    }
  });

// ─── Inferred Input Types ───

export type LspDiagnosticsInput = z.infer<typeof LspDiagnosticsInputSchema>;
export type LspGotoDefinitionInput = z.infer<typeof LspGotoDefinitionInputSchema>;
export type LspFindReferencesInput = z.infer<typeof LspFindReferencesInputSchema>;
export type LspSymbolsInput = z.infer<typeof LspSymbolsInputSchema>;
