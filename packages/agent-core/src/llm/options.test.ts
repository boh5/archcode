import { describe, expect, test } from "bun:test";
import { pickModelCallOptions } from "./options";

describe("pickModelCallOptions", () => {
  test("picks whitelisted options and forces AI SDK maxRetries to 0", () => {
    const providerOptions = { testProvider: { mode: "full" } };
    const result = pickModelCallOptions({
      maxOutputTokens: 256,
      temperature: 0.6,
      topP: 0.75,
      topK: 12,
      presencePenalty: -0.5,
      frequencyPenalty: 0.5,
      stopSequences: ["DONE"],
      seed: 42,
      maxRetries: 99,
      timeout: 20_000,
      providerOptions,
      variant: "never-forward",
    } as Parameters<typeof pickModelCallOptions>[0] & { variant: string });

    expect(result).toEqual({
      maxOutputTokens: 256,
      temperature: 0.6,
      topP: 0.75,
      topK: 12,
      presencePenalty: -0.5,
      frequencyPenalty: 0.5,
      stopSequences: ["DONE"],
      seed: 42,
      timeout: 20_000,
      providerOptions,
      maxRetries: 0,
    });
    expect(result).not.toHaveProperty("variant");
  });

  test("returns maxRetries 0 even without model options", () => {
    expect(pickModelCallOptions(undefined)).toEqual({ maxRetries: 0 });
  });
});
