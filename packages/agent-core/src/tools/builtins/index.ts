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
export { cancelSessionTool, CancelSessionInputSchema, executeCancelSession } from "./cancel-session";
export { memoryWriteTool, MemoryWriteInputSchema } from "./memory-write";
export { skillListTool, createSkillListTool, SkillListInputSchema } from "./skill-list";
export { skillReadTool, createSkillReadTool, SkillReadInputSchema } from "./skill-read";
export { viewToolOutputTool } from "./view-tool-output";
export { astGrepSearchTool, astGrepReplaceTool } from "./ast-grep";
export { compressTool, CompressInputSchema } from "./compress";
export { worktreeEnterTool, worktreeExitTool, WorktreeEnterInputSchema, WorktreeExitInputSchema } from "./worktree";
export { automationCreateTool } from "./automation-create";
export { projectTodoUpdateTool, ProjectTodoUpdateInputSchema } from "./project-todo-update";

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
import { cancelSessionTool } from "./cancel-session";
import { viewToolOutputTool } from "./view-tool-output";
import { astGrepSearchTool, astGrepReplaceTool } from "./ast-grep";
import { skillListTool } from "./skill-list";
import { skillReadTool } from "./skill-read";
import { compressTool } from "./compress";
import { worktreeEnterTool, worktreeExitTool } from "./worktree";
import { projectTodoUpdateTool } from "./project-todo-update";

export function createBuiltinToolDescriptors(): AnyToolDescriptor[] {
  return [
    fileReadTool,
    fileWriteTool,
    fileEditTool,
    grepTool,
    globTool,
    astGrepSearchTool,
    astGrepReplaceTool,
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
    cancelSessionTool,
    skillListTool,
    skillReadTool,
    viewToolOutputTool,
    compressTool,
    worktreeEnterTool,
    worktreeExitTool,
    projectTodoUpdateTool,
  ];
}
