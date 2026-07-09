import type { ModelCallOptions } from "../config/provider";
import type { ModelInfo } from "../provider/model";
import { runLlmText } from "../llm";

export type TitleGenerationKind = "session" | "goal" | "loop";

export interface GenerateTitleInput {
  readonly kind: TitleGenerationKind;
  readonly text: string;
  readonly modelInfo: ModelInfo;
  readonly modelOptions?: ModelCallOptions;
}

const TITLE_MAX_LENGTH = 50;

export async function generateTitle(input: GenerateTitleInput): Promise<string | null> {
  const source = input.text.trim();
  if (!source) return null;

  const result = await runLlmText({
    model: input.modelInfo.model,
    prompt: buildTitlePrompt(input.kind, source),
    modelOptions: input.modelOptions,
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
  const subject = kind === "session"
    ? "session"
    : kind === "goal"
      ? "Goal"
      : "Loop";
  return `Generate a concise ${subject} title (3-8 words) based on this text: ${text}`;
}
