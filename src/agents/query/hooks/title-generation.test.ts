import { describe, expect, mock, test, beforeEach } from "bun:test";
import { createSessionStore } from "../../../store/store";
import { createTitleGenerationHook } from "./title-generation";
import type { StoredMessage, StepInfo } from "../../../store/types";

const mockDispatch = mock(() => {});

const mockBtm = { dispatch: mockDispatch };

const mockProviderRegistry = {
  modelIds: ["test:model"],
  getModel: mock(() => ({ model: {} })),
};

function makeUserMessage(text: string, now: number): StoredMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [
      {
        type: "text",
        id: crypto.randomUUID(),
        text,
        createdAt: now,
        completedAt: now,
      },
    ],
    createdAt: now,
    completedAt: now,
  };
}

function makeStep0(now: number): StepInfo {
  return {
    id: crypto.randomUUID(),
    step: 0,
    startedAt: now,
    completedAt: now,
    finishReason: "stop",
  };
}

describe("createTitleGenerationHook", () => {
  beforeEach(() => {
    mockDispatch.mockReset();
    mockDispatch.mockImplementation(() => {});
    mockProviderRegistry.getModel.mockReset();
  });

  test("dispatches title-generation on step 0 completion when no title set", async () => {
    const now = Date.now();
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [makeUserMessage("Hello world", now)],
      steps: [makeStep0(now)],
    });

    const ctx = { store, modelInfo: undefined as never };
    const hook = createTitleGenerationHook(mockBtm as never, mockProviderRegistry as never);
    await hook(ctx as never);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith(
      "title-generation",
      expect.any(Function),
    );
  });

  test("skips dispatch when title already set", async () => {
    const now = Date.now();
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      title: "Already titled",
      messages: [makeUserMessage("Hello", now)],
      steps: [makeStep0(now)],
    });

    const ctx = { store, modelInfo: undefined as never };
    const hook = createTitleGenerationHook(mockBtm as never, mockProviderRegistry as never);
    await hook(ctx as never);

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test("skips dispatch when no step 0", async () => {
    const store = createSessionStore(crypto.randomUUID());

    const ctx = { store, modelInfo: undefined as never };
    const hook = createTitleGenerationHook(mockBtm as never, mockProviderRegistry as never);
    await hook(ctx as never);

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test("skips dispatch when step 0 has no completedAt", async () => {
    const now = Date.now();
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [makeUserMessage("Hello", now)],
      steps: [
        {
          id: crypto.randomUUID(),
          step: 0,
          startedAt: now,
        },
      ],
    });

    const ctx = { store, modelInfo: undefined as never };
    const hook = createTitleGenerationHook(mockBtm as never, mockProviderRegistry as never);
    await hook(ctx as never);

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test("only dispatches once (stepZeroTriggered guard)", async () => {
    const now = Date.now();
    const store = createSessionStore(crypto.randomUUID());
    const stepData = {
      messages: [makeUserMessage("Hello", now)],
      steps: [makeStep0(now)],
    };
    store.setState(stepData);

    const ctx = { store, modelInfo: undefined as never };
    const hook = createTitleGenerationHook(mockBtm as never, mockProviderRegistry as never);

    await hook(ctx as never);
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    mockDispatch.mockReset();
    await hook(ctx as never);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
