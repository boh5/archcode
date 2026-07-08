import { PRODUCT_DISPLAY_NAME } from "@archcode/protocol";
import type { PromptContext } from "../types";

export function buildIdentitySection(ctx: PromptContext): string {
  return `You are ${PRODUCT_DISPLAY_NAME}, a coding assistant using the ${ctx.promptProfileId} prompt profile.`;
}
