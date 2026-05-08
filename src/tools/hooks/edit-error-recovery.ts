import type { AfterHook, ToolExecutionResult } from "../types";

interface NudgeRule {
  patterns: RegExp[];
  nudge: string;
}

const NUDGE_RULES: NudgeRule[] = [
  {
    patterns: [/TOOL_FILE_NOT_READ_FIRST/],
    nudge:
      "You must read the file first using file_read before editing it.",
  },
  {
    patterns: [/TOOL_FILE_WRITE_CONFLICT/],
    nudge:
      "The file was modified externally since you last read it. Re-read the file to get the current content before editing.",
  },
  {
    patterns: [/oldString.*not found/i, /no match/i],
    nudge:
      "The oldString was not found in the file. This can happen if the file was modified since you last read it, or if the text contains whitespace differences. Try re-reading the file and using the exact text content.",
  },
  {
    patterns: [/multiple matches/i, /ambiguous/i],
    nudge:
      "The oldString matched multiple locations in the file. Provide more surrounding context to make the match unique.",
  },
  {
    patterns: [/overlapping edits/i],
    nudge:
      "The edits overlap with each other. Ensure each oldString targets a non-overlapping section of the file.",
  },
];

const FALLBACK_NUDGE =
  "The edit failed. Try re-reading the file and ensuring your oldString exactly matches the current content.";

const SEPARATOR = "\n---\n";

function findNudge(output: string): string {
  for (const rule of NUDGE_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(output)) {
        return rule.nudge;
      }
    }
  }
  return FALLBACK_NUDGE;
}

export function createEditErrorRecoveryHook(): AfterHook {
  return (result: ToolExecutionResult): ToolExecutionResult | void => {
    if (!result.isError) {
      return;
    }

    const nudge = findNudge(result.output);

    return {
      ...result,
      output: `${result.output}${SEPARATOR}${nudge}`,
    };
  };
}
