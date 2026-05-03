import { tool } from "ai";
import { z } from "zod";

/** Placeholder tool for development — echoes back the input message. */
export const echoTool = tool({
  description: "Echo back the input message",
  inputSchema: z.object({
    message: z.string().describe("The message to echo back"),
  }),
});

/** Corresponding executor for {@link echoTool}. */
export const echoExecutor = async (input: { message: string }): Promise<string> => {
  return input.message;
};
