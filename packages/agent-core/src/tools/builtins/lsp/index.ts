import type { AnyToolDescriptor } from "../../types";

export { lspDiagnosticsTool } from "./lsp-diagnostics";
export { lspGotoDefinitionTool } from "./lsp-goto-definition";
export { lspFindReferencesTool } from "./lsp-find-references";
export { lspSymbolsTool } from "./lsp-symbols";
export { configureDefaultLspToolLogger } from "./tool-logger";

import { lspDiagnosticsTool } from "./lsp-diagnostics";
import { lspGotoDefinitionTool } from "./lsp-goto-definition";
import { lspFindReferencesTool } from "./lsp-find-references";
import { lspSymbolsTool } from "./lsp-symbols";

export function createLspToolDescriptors(): AnyToolDescriptor[] {
  return [
    lspDiagnosticsTool,
    lspGotoDefinitionTool,
    lspFindReferencesTool,
    lspSymbolsTool,
  ];
}
