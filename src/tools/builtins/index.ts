import type { ToolDescriptor } from "../types";

export { fileReadTool } from "./file-read";
export { fileWriteTool } from "./file-write";
export { fileEditTool } from "./file-edit";
export { grepTool, setRipgrepService as setGrepRipgrepService, GrepInputSchema } from "./grep";
export { globTool, setRipgrepService as setGlobRipgrepService, GlobInputSchema } from "./glob";
export { gitStatusTool, parseGitStatusOutput, runGitStatus } from "./git-status";
export { gitDiffTool, buildArgs as buildGitDiffArgs } from "./git-diff";

import { fileReadTool } from "./file-read";
import { fileWriteTool } from "./file-write";
import { fileEditTool } from "./file-edit";
import { grepTool } from "./grep";
import { globTool } from "./glob";
import { gitStatusTool } from "./git-status";
import { gitDiffTool } from "./git-diff";

export function createBuiltinToolDescriptors(): ToolDescriptor[] {
  return [
    fileReadTool,
    fileWriteTool,
    fileEditTool,
    grepTool,
    globTool,
    gitStatusTool,
    gitDiffTool,
  ];
}