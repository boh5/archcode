import { describe, expect, mock, test } from "bun:test";
import type { AskUserRequest, SpecraRuntime } from "@specra/agent-core";
import { AskUserService } from "./ask-user-service";

const request: AskUserRequest = {
  toolName: "ask_user",
  toolCallId: "call-1",
  questions: [
    {
      question: "Which option?",
      header: "Choice",
      options: [{ label: "Yes", description: "Approve" }],
      custom: true,
    },
  ],
};

function createRuntime() {
  return {
    requestQuestion: mock(async () => ({ answers: [["Yes"]] })),
    respondQuestion: mock(() => true),
    cleanupDeferredSession: mock(() => undefined),
  } as unknown as SpecraRuntime;
}

describe("AskUserService", () => {
  test("request delegates to runtime question boundary", async () => {
    const runtime = createRuntime();
    const service = new AskUserService(runtime);

    await expect(service.request("session-1", "/tmp/workspace", request)).resolves.toEqual({ answers: [["Yes"]] });

    expect(runtime.requestQuestion).toHaveBeenCalledWith("/tmp/workspace", "session-1", request);
  });

  test("respond delegates to runtime response boundary", () => {
    const runtime = createRuntime();
    const service = new AskUserService(runtime);

    expect(service.respond("question-1", { answers: [["Yes"]] })).toBe(true);
    expect(runtime.respondQuestion).toHaveBeenCalledWith("question-1", { answers: [["Yes"]] });
  });

  test("cleanup delegates scoped session cleanup when both identifiers are present", () => {
    const runtime = createRuntime();
    const service = new AskUserService(runtime);

    service.cleanup("session-1", "/tmp/workspace");
    service.cleanup(undefined, "/tmp/workspace");

    expect(runtime.cleanupDeferredSession).toHaveBeenCalledTimes(1);
    expect(runtime.cleanupDeferredSession).toHaveBeenCalledWith("/tmp/workspace", "session-1");
  });
});
