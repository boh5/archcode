import type { HitlResponse } from "@archcode/protocol";
import { z } from "zod/v4";

import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { RawToolResult, ToolBlockedRequest, ToolExecutionContext } from "../types";
import { createAskUserSuccessResult } from "./ask-user-format";

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedString(maxBytes: number, description: string) {
  return z.string().refine((value) => utf8Bytes(value) <= maxBytes, description);
}

const AskUserQuestionOptionSchema = z.strictObject({
  label: boundedString(256, "Option label exceeds 256 UTF-8 bytes")
    .describe("Concise option text, 1-5 words."),
  description: boundedString(2 * 1024, "Option description exceeds 2 KiB")
    .describe("What selecting this option means or changes."),
});

const AskUserQuestionSchema = z.strictObject({
  question: boundedString(2 * 1024, "Question exceeds 2 KiB")
    .min(1)
    .describe("Clear, specific full question whose answer changes the execution direction."),
  header: boundedString(256, "Question header exceeds 256 UTF-8 bytes")
    .min(1)
    .describe("Very short display heading."),
  options: z.array(AskUserQuestionOptionSchema).max(3).optional().default([])
    .describe("Up to three choices. Put the recommended option first and suffix its label with `(Recommended)`. Do not add an `Other` option when custom is enabled."),
  multiple: z.boolean().optional()
    .describe("Set true only when more than one choice may be selected."),
  custom: z.boolean().optional().default(true)
    .describe("When true (default), the UI adds a free-text answer choice automatically."),
});

export const AskUserInputSchema = z.strictObject({
  questions: z.array(AskUserQuestionSchema).min(1).max(3)
    .describe("One to three independent user decisions to ask in this interaction."),
});

export type AskUserInput = z.infer<typeof AskUserInputSchema>;

export function prepareAskUserBlock(
  input: AskUserInput,
  ctx: ToolExecutionContext,
): ToolBlockedRequest {
  return ctx.projectContext.hitl.codec.createAskUserRequest({
    toolCallId: ctx.toolCallId,
    displayPayload: {
      title: input.questions[0]?.header ?? "Question",
      summary: input.questions[0]?.question ?? "User input required",
      questions: input.questions.map((question) => ({
        question: question.question,
        header: question.header,
        options: question.options.map((option) => ({
          label: option.label,
          description: option.description,
        })),
        ...(question.multiple === undefined ? {} : { multiple: question.multiple }),
        custom: question.custom,
      })),
      redacted: true,
    },
  });
}

export function resumeAskUser(
  input: AskUserInput,
  response: HitlResponse,
  ctx: ToolExecutionContext,
): RawToolResult {
  const request = prepareAskUserBlock(input, ctx);
  const parsed = ctx.projectContext.hitl.codec.parseResponseForRequest(request, response);

  if (parsed.type === "cancel") {
    return createToolErrorResult({ kind: "cancelled", message: parsed.reason });
  }
  if (parsed.type !== "question_answer") {
    throw new TypeError(`${parsed.type} cannot resume ask_user`);
  }
  if (parsed.answers.length !== input.questions.length) {
    return createToolErrorResult({
      kind: "cancelled",
      message: `ask_user received ${parsed.answers.length} answers but expected ${input.questions.length}`,
    });
  }
  const emptyIndex = parsed.answers.findIndex((answer) => answer.length === 0);
  if (emptyIndex !== -1) {
    return createToolErrorResult({
      kind: "cancelled",
      message: `ask_user received empty answer for question ${emptyIndex + 1}`,
    });
  }

  const safeQuestions = (request.displayPayload.questions ?? []).map((question) => ({
    question: question.question,
    header: question.header,
    options: question.options ?? [],
    ...(question.multiple === undefined ? {} : { multiple: question.multiple }),
    custom: question.custom,
  }));

  return createAskUserSuccessResult(
    parsed.answers.map((answer) => [answer]),
    safeQuestions,
  );
}

export const askUserTool = defineTool({
  name: "ask_user",
  description: [
    "Ask for one or more unresolved preferences, requirements, or implementation choices that genuinely belong to the user and would change the execution direction.",
    "",
    "Investigate first. Do not ask for facts available from the request, repository, tool output, or a sensible reversible default. Do not use this tool merely to report progress or to ask permission for an ordinary in-scope next step.",
    "",
    "Put a recommended option first and suffix its label with `(Recommended)`. With custom enabled, the UI adds the free-text choice automatically; do not add an `Other` option yourself.",
  ].join("\n"),
  inputSchema: AskUserInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: false },
  outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
  prepareBlock: prepareAskUserBlock,
  resume: resumeAskUser,
  execute: () => {
    throw new Error("ask_user initial execution is invalid; ToolRegistry must suspend via prepareBlock");
  },
});
