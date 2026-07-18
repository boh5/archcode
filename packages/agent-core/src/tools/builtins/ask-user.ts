import { z } from "zod";
import { defineTool } from "../define-tool";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { createToolErrorResult } from "../errors";
import { createAskUserSuccessResult } from "./ask-user-format";
import { redactString } from "../security/redaction";

// ─── Input Schema ───

const AskUserQuestionOptionSchema = z.object({
  label: z.string().describe("Concise option text, 1-5 words."),
  description: z.string().describe("What selecting this option means or changes."),
}).strict();

const AskUserQuestionSchema = z.object({
  question: z.string().min(1).describe("Clear, specific full question whose answer changes the execution direction."),
  header: z.string().min(1).max(30).describe("Very short display heading, at most 30 characters."),
  options: z.array(AskUserQuestionOptionSchema).optional().default([]).describe("Available choices. Do not add an `Other` option when custom is enabled. Put a recommended choice first and suffix its label with `(Recommended)`."),
  multiple: z.boolean().optional().describe("Set true only when more than one choice may be selected."),
  custom: z.boolean().optional().default(true).describe("When true (default), adds a free-text answer choice automatically. Set false only when the user must choose from the supplied options."),
}).strict();

export const AskUserInputSchema = z
  .object({
    questions: z.array(AskUserQuestionSchema).min(1).describe("One or more independent user decisions to ask in this interaction."),
  })
  .strict();

export type AskUserInput = z.infer<typeof AskUserInputSchema>;

type AskUserResult = Awaited<ReturnType<NonNullable<ToolExecutionContext["askUser"]>>>;

// ─── Execute Logic ───

export async function executeAskUser(
  input: AskUserInput,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const askUser = ctx.askUser;
  if (!askUser) {
    return {
      output: "",
      isError: false,
      blocked: {
        source: { type: "ask_user", toolCallId: ctx.toolCallId },
        displayPayload: {
          title: redactString(input.questions[0]?.header ?? "Question"),
          summary: redactString(input.questions[0]?.question ?? "User input required"),
          questions: input.questions.map((question) => ({
            question: redactString(question.question),
            header: redactString(question.header),
            options: question.options.map((option) => ({
              label: redactString(option.label),
              description: redactString(option.description),
            })),
            ...(question.multiple === undefined ? {} : { multiple: question.multiple }),
            custom: question.custom,
          })),
          redacted: true,
        },
      },
    };
  }

  if (ctx.abort.aborted) {
    return createToolErrorResult({ kind: "cancelled", message: "ask_user was aborted" });
  }

  const abortRace = rejectOnAbort(ctx.abort);
  let result: AskUserResult;
  try {
    result = await Promise.race([
      askUser!({
        toolName: ctx.toolName,
        toolCallId: ctx.toolCallId,
        questions: input.questions,
        abortSignal: ctx.abort,
      }),
      abortRace.promise,
    ]);
  } catch (err) {
    if (err instanceof AskUserAbortError) {
      return createToolErrorResult({ kind: "cancelled", message: "ask_user was aborted" });
    }
    throw err;
  } finally {
    abortRace.cleanup();
  }

  if ("answers" in result) {
    // Validate answers length matches questions
    if (result.answers.length !== input.questions.length) {
      return createToolErrorResult({
        kind: "cancelled",
        message: `ask_user received ${result.answers.length} answers but expected ${input.questions.length}`,
      });
    }
    // Validate no empty answers
    const emptyIndex = result.answers.findIndex((a) => a.length === 0);
    if (emptyIndex !== -1) {
      return createToolErrorResult({
        kind: "cancelled",
        message: `ask_user received empty answer for question ${emptyIndex + 1}`,
      });
    }
    return createAskUserSuccessResult(result.answers, input.questions);
  }

  return createToolErrorResult({ kind: "cancelled", message: result.reason });
}

class AskUserAbortError extends Error {
  constructor() {
    super("ask_user was aborted");
    this.name = "AskUserAbortError";
  }
}

function rejectOnAbort(signal: AbortSignal): { promise: Promise<never>; cleanup: () => void } {
  let cleanup = () => {};
  const promise = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new AskUserAbortError());
    cleanup = () => signal.removeEventListener("abort", onAbort);

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });

  return { promise, cleanup };
}

// ─── Tool Definition ───

export const askUserTool = defineTool({
  name: "ask_user",
  description: [
    "Ask for one or more unresolved preferences, requirements, or implementation choices that genuinely belong to the user and would change the execution direction.",
    "",
    "Investigate first. Do not ask for facts available from the request, repository, tool output, or a sensible reversible default. Do not use this tool merely to report progress or to ask permission for an ordinary in-scope next step. A good question presents the concrete tradeoff discovered by investigation; a bad question asks which file to edit before searching the code.",
    "",
    "Example: `ask_user({\"questions\":[{\"header\":\"Storage\",\"question\":\"Which persistence boundary should this feature use?\",\"options\":[{\"label\":\"Project file (Recommended)\",\"description\":\"Keeps state portable with the workspace.\"},{\"label\":\"User database\",\"description\":\"Shares state across projects.\"}],\"multiple\":false,\"custom\":true}]})`. Put a recommended option first and suffix its label with `(Recommended)`. With custom enabled, the UI adds the free-text choice automatically; do not add an `Other` option yourself.",
  ].join("\n"),
  inputSchema: AskUserInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: false },
  execute: async (input: AskUserInput, ctx: ToolExecutionContext) => {
    return executeAskUser(input, ctx);
  },
});
