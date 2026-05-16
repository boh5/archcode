import { afterAll, afterEach, describe, expect, mock, test, beforeEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { generateText } from "ai";
import { createSessionStore } from "../../../store/store";
import { createTitleGenerationHook } from "./title-generation";
import type { BeforeModelCallContext } from "../loop-hooks";
import type { ModelInfo } from "../../../provider/model";
import { __setGenerateTextForTest } from "../../../background/tasks/title-generation";
import { __setSessionsDirForTest } from "../../../store/sessions-dir";

const mockDispatch = mock((_name: string, _task: () => Promise<void>) => {});
const mockGenerateText = mock(async () => ({ text: "Hook title" }));

const mockBtm = { dispatch: mockDispatch };
const TEST_TMP = join(import.meta.dir, "__test_tmp__", "title-generation-hook");

function makeModelInfo(): ModelInfo {
  return {
    model: { provider: "test" } as never,
    displayName: "Test Model",
    limit: { context: 4096, output: 1024 },
    modalities: { input: ["text"], output: ["text"] },
    providerId: "test",
    modelId: "test-model",
    qualifiedId: "test:test-model",
  };
}

describe("createTitleGenerationHook", () => {
  beforeEach(async () => {
    mockDispatch.mockReset();
    mockDispatch.mockImplementation(() => {});
    mockGenerateText.mockReset();
    mockGenerateText.mockImplementation(async () => ({ text: "Hook title" }));
    __setGenerateTextForTest(mockGenerateText as unknown as typeof generateText);
    await mkdir(TEST_TMP, { recursive: true });
    __setSessionsDirForTest(TEST_TMP);
  });

  afterEach(() => {
    __setGenerateTextForTest(generateText as unknown as typeof generateText);
    __setSessionsDirForTest(undefined);
  });

  afterAll(async () => {
    await rm(TEST_TMP, { recursive: true, force: true });
  });

  test("dispatches title-generation on first model call when no title set", async () => {
    const store = createSessionStore(crypto.randomUUID());

    const ctx: BeforeModelCallContext = {
      store,
      modelInfo: makeModelInfo(),
      messages: [],
    };
    const hook = createTitleGenerationHook(mockBtm as never);
    await hook(ctx);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith(
      "title-generation",
      expect.any(Function),
    );
  });

  test("skips dispatch when title already set", async () => {
    const store = createSessionStore(crypto.randomUUID());
    store.setState({ title: "Already titled" });

    const ctx: BeforeModelCallContext = {
      store,
      modelInfo: makeModelInfo(),
      messages: [],
    };
    const hook = createTitleGenerationHook(mockBtm as never);
    await hook(ctx);

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test("only dispatches once (triggered guard)", async () => {
    const store = createSessionStore(crypto.randomUUID());

    const ctx: BeforeModelCallContext = {
      store,
      modelInfo: makeModelInfo(),
      messages: [],
    };
    const hook = createTitleGenerationHook(mockBtm as never);

    await hook(ctx);
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    mockDispatch.mockReset();
    await hook(ctx);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test("passes modelOptions to dispatched title generation task", async () => {
    const store = createSessionStore(crypto.randomUUID());
    const modelOptions = { temperature: 0.1, maxOutputTokens: 128 };
    const now = Date.now();
    store.setState({
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [
            {
              type: "text",
              id: crypto.randomUUID(),
              text: "Generate a title for configured options",
              createdAt: now,
              completedAt: now,
            },
          ],
          createdAt: now,
          completedAt: now,
        },
      ],
    });

    const ctx: BeforeModelCallContext = {
      store,
      modelInfo: makeModelInfo(),
      modelOptions,
      messages: [],
    };

    const hook = createTitleGenerationHook(mockBtm as never);
    await hook(ctx);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const dispatchRun = mockDispatch.mock.calls[0]![1];
    await dispatchRun();
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.1,
        maxOutputTokens: 128,
      }),
    );
  });
});
