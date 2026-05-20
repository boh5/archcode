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
    filePath: z.string(),
    severity: z.enum(["error", "warning", "information", "hint", "all"]).optional(),
  })
  .strict();

export const LspGotoDefinitionInputSchema = z
  .object({
    filePath: z.string(),
    line: z.number(),
    character: z.number(),
  })
  .strict();

export const LspFindReferencesInputSchema = z
  .object({
    filePath: z.string(),
    line: z.number(),
    character: z.number(),
    includeDeclaration: z.boolean().optional(),
  })
  .strict();

export const LspSymbolsInputSchema = z
  .object({
    scope: z.enum(["document", "workspace"]),
    filePath: z.string().optional(),
    query: z.string().optional(),
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
