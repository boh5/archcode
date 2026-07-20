import { z } from "zod/v4";
import type { NormalizedUsage } from "@archcode/protocol";
import type { ExecutionModelBinding } from "../models";
import { runLlmObject } from "../llm";
import type { Logger } from "../logger";
import type { SessionStoreState } from "../store/types";

const GoalEvaluatorOutputSchema = z.strictObject({
  decision: z.enum(["continue", "candidate_complete"]),
  reason: z.string().trim().min(1).max(1_000),
  madeProgress: z.boolean(),
});

export type SessionGoalEvaluation = z.output<typeof GoalEvaluatorOutputSchema>;

/** Tool-less internal checkpoint. It may nominate completion but never commits it. */
export class SessionGoalEvaluator {
  constructor(private readonly logger: Logger) {}

  async evaluate(input: {
    readonly binding: ExecutionModelBinding;
    readonly state: Readonly<SessionStoreState>;
    readonly objective: string;
    readonly abortSignal?: AbortSignal;
    readonly onUsage?: (usage: NormalizedUsage) => void;
  }): Promise<SessionGoalEvaluation> {
    const recent = JSON.stringify(input.state.messages.slice(-12)).slice(-24_000);
    const lastExecution = input.state.executions.at(-1);
    return await runLlmObject({
      model: input.binding.modelInfo.model,
      modelOptions: input.binding.options,
      logger: this.logger,
      redactSensitiveText: (text) => input.binding.modelInfo.redactSensitiveText(text),
      ...(input.onUsage === undefined ? {} : { onUsage: input.onUsage }),
      schema: GoalEvaluatorOutputSchema,
      schemaName: "goal_evaluation",
      schemaDescription: "Choose whether the Goal needs another Engineer turn or is ready for independent review",
      abortSignal: input.abortSignal,
      system: [
        "You are an internal, tool-less progress evaluator.",
        "You cannot complete the Goal. candidate_complete only requests an independent Reviewer.",
        "Choose continue unless the transcript contains concrete evidence that every part of the objective is implemented and verified.",
        "madeProgress means the latest execution produced new, concrete progress rather than repeating the same state.",
      ].join("\n"),
      prompt: [
        "Goal objective (authoritative, verbatim):",
        input.objective,
        "",
        `Last execution: ${lastExecution?.status ?? "none"}`,
        "Recent canonical Session messages:",
        recent,
      ].join("\n"),
    });
  }
}
