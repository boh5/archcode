import type { ExecutionModelBinding } from "../models";
import { runLlmText } from "../llm";
import type { RetryScheduler } from "../llm/retry";

export type TitleGenerationKind = "session" | "goal";

export interface GenerateTitleInput {
  readonly kind: TitleGenerationKind;
  readonly text: string;
  readonly binding: ExecutionModelBinding;
  readonly retryScheduler?: RetryScheduler;
}

const TITLE_MAX_LENGTH = 50;

export async function generateTitle(input: GenerateTitleInput): Promise<string | null> {
  const source = input.text.trim();
  if (!source) return null;

  const result = await runLlmText({
    model: input.binding.modelInfo.model,
    prompt: buildTitlePrompt(input.kind, source),
    modelOptions: input.binding.options,
    retryScheduler: input.retryScheduler,
    redactSensitiveText: (text) => input.binding.modelInfo.redactSensitiveText(text),
  });

  const title = normalizeGeneratedTitle(result.text);
  return title.length === 0 ? null : title;
}

export function normalizeGeneratedTitle(value: string): string {
  return value
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim()
    .slice(0, TITLE_MAX_LENGTH);
}

function buildTitlePrompt(kind: TitleGenerationKind, text: string): string {
  const subject = kind === "session" ? "session" : "Goal";
  return `Generate a concise ${subject} title (3-8 words) based on this text: ${text}`;
}
