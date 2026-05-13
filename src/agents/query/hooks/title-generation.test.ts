import { describe, expect, mock, test, beforeEach } from "bun:test";
import { createSessionStore } from "../../../store/store";
import { createTitleGenerationHook } from "./title-generation";
import type { ModelMessage } from "ai";
import type { BeforeModelCallContext } from "../loop-hooks";
import type { ModelInfo } from "../../../provider/model";

const mockDispatch = mock(() => {});

const mockBtm = { dispatch: mockDispatch };

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
  beforeEach(() => {
    mockDispatch.mockReset();
    mockDispatch.mockImplementation(() => {});
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
});