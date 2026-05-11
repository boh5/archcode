import type { AnyToolDescriptor } from "../types";

export { fileReadTool } from "./file-read";
export { fileWriteTool } from "./file-write";
export { fileEditTool } from "./file-edit";
export { grepTool, setRipgrepService as setGrepRipgrepService, GrepInputSchema } from "./grep";
export { globTool, setRipgrepService as setGlobRipgrepService, GlobInputSchema } from "./glob";
export { gitStatusTool, parseGitStatusOutput, runGitStatus } from "./git-status";
export { gitDiffTool, buildArgs as buildGitDiffArgs } from "./git-diff";
export { bashTool, BashInputSchema, runBashCommand } from "./bash";
export { todoWriteTool, TodoWriteInputSchema } from "./todo-write";
export { askUserTool, AskUserInputSchema, executeAskUser } from "./ask-user";
export { lspDiagnosticsTool, lspGotoDefinitionTool, lspFindReferencesTool, lspSymbolsTool, createLspToolDescriptors } from "./lsp";
export { webFetchTool, WebFetchInputSchema, runWebFetch, validateUrl } from "./web-fetch";
export { waitForReminderTool, WaitForReminderInputSchema, executeWaitForReminder } from "./wait-for-reminder";
export { delegateTool, DelegateInputSchema, executeDelegate } from "./delegate";
export { backgroundOutputTool, BackgroundOutputInputSchema, executeBackgroundOutput } from "./background-output";
export { memoryWriteTool, MemoryWriteInputSchema } from "./memory-write";

import { fileReadTool } from "./file-read";
import { fileWriteTool } from "./file-write";
import { fileEditTool } from "./file-edit";
import { grepTool } from "./grep";
import { globTool } from "./glob";
import { gitStatusTool } from "./git-status";
import { gitDiffTool } from "./git-diff";
import { bashTool } from "./bash";
import { todoWriteTool } from "./todo-write";
import { askUserTool } from "./ask-user";
import { lspDiagnosticsTool, lspGotoDefinitionTool, lspFindReferencesTool, lspSymbolsTool } from "./lsp";
import { webFetchTool } from "./web-fetch";
import { waitForReminderTool } from "./wait-for-reminder";
import { delegateTool } from "./delegate";
import { backgroundOutputTool } from "./background-output";

export function createBuiltinToolDescriptors(): AnyToolDescriptor[] {
  return [
    fileReadTool,
    fileWriteTool,
    fileEditTool,
    grepTool,
    globTool,
    gitStatusTool,
    gitDiffTool,
    bashTool,
    todoWriteTool,
    askUserTool,
    lspDiagnosticsTool,
    lspGotoDefinitionTool,
    lspFindReferencesTool,
    lspSymbolsTool,
    webFetchTool,
    waitForReminderTool,
    delegateTool,
    backgroundOutputTool,
  ];
}
