import type { AskUserInput } from "./ask-user";

export function formatAskUserAnswers(answers: string[][], questions: AskUserInput["questions"]): string {
  if (questions.length === 1) {
    const answer = answers[0];
    if (!answer || answer.length === 0) return "";
    return answer.join(", ");
  }

  const lines = questions.map((question, index) => {
    const answer = answers[index];
    if (!answer || answer.length === 0) return `${question.header}: `;
    return `${question.header}: ${answer.join(", ")}`;
  });
  return lines.join("\n");
}
