import type { AskUserInput } from "./ask-user";
import type { ToolExecutionResult } from "../types";

export const ASK_USER_RESULT_META_KEY = "askUser";

export interface AskUserResultMetadata {
  version: 1;
  answers: string[][];
}

export function formatAskUserAnswers(answers: string[][], questions: AskUserInput["questions"]): string {
  const lines = questions.flatMap((question, index) => [
    `Question ${index + 1} (${question.header}): ${JSON.stringify(question.question)}`,
    `Answer ${index + 1}: ${JSON.stringify(answers[index] ?? [])}`,
  ]);
  return [
    "User has answered your questions:",
    ...lines,
    "You can now continue with the user's answers in mind. If an answer is ambiguous, ask a targeted follow-up instead of repeating the same question.",
  ].join("\n");
}

export function createAskUserSuccessResult(
  answers: string[][],
  questions: AskUserInput["questions"],
): ToolExecutionResult {
  const metadata: AskUserResultMetadata = {
    version: 1,
    answers: answers.map((answer) => [...answer]),
  };
  return {
    output: formatAskUserAnswers(answers, questions),
    isError: false,
    meta: { [ASK_USER_RESULT_META_KEY]: metadata },
  };
}
