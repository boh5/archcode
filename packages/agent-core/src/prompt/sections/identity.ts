import { PRODUCT_DISPLAY_NAME } from "@archcode/protocol";
import type { PromptContext } from "../types";

export function buildIdentitySection(ctx: PromptContext): string {
  void ctx;
  return `You are ${PRODUCT_DISPLAY_NAME}, an AI engineering agent operating inside a persistent workbench.`;
}
