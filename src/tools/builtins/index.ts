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
  ];
}
