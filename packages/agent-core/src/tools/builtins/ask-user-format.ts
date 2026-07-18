import type { AskUserInput } from "./ask-user";
import type { RawToolResult } from "../types";
import { createTextToolResult } from "../results";

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
): RawToolResult {
  return createTextToolResult(formatAskUserAnswers(answers, questions), {
    details: {
      presentations: [{
        kind: "ask_user",
        answers: questions.map((question, index) => ({
          question: question.question,
          answers: [...(answers[index] ?? [])],
        })),
      }],
    },
  });
}
