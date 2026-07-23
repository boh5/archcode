import { afterAll, afterEach, describe, expect, mock, test, beforeEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { SessionStoreManager } from "../../../store/session-store-manager";
import { createTitleGenerationHook } from "./title-generation";
import type { BeforeModelCallContext } from "../loop-hooks";
import type { ModelInfo } from "../../../provider/model";
import { createTestModelInfo } from "../../../testing/test-execution-fixtures";
import type { ExecutionModelBinding } from "../../../models";
import { setLlmAdapterForTest } from "../../../llm";
import { __setSessionsDirForTest } from "../../../store/sessions-dir";
import { silentLogger } from "../../../logger";

const mockDispatch = mock((_name: string, _task: () => Promise<void>) => {});
const mockGenerateText = mock(async () => ({ text: "Hook title" }));

const mockBtm = { dispatch: mockDispatch };
const TEST_TMP = join(import.meta.dir, "__test_tmp__", "title-generation-hook", crypto.randomUUID());
const WORKSPACE_ROOT = join(TEST_TMP, "workspace");
const storeManager = new SessionStoreManager({ logger: silentLogger });
const sessionIds = new Set<string>();

function createStore(sessionId = crypto.randomUUID()) {
  sessionIds.add(sessionId);
  return storeManager.create(sessionId, WORKSPACE_ROOT, { agentName: "lead" });
}

function makeModelInfo(): ModelInfo {
  return createTestModelInfo();
}

function makeBinding(options?: ExecutionModelBinding["options"]): ExecutionModelBinding {
  const modelInfo = makeModelInfo();
  return {
    modelInfo,
    options,
    summary: {
      selection: { model: modelInfo.qualifiedId },
      providerId: modelInfo.providerId,
      modelId: modelInfo.modelId,
      providerDisplayName: modelInfo.providerDisplayName,
      modelDisplayName: modelInfo.displayName,
      resolution: "profile_default",
      modelRuntimeRevision: "test-revision",
    },
  };
}

describe("createTitleGenerationHook", () => {
  beforeEach(async () => {
    storeManager.clearAll();
    mockDispatch.mockReset();
    mockDispatch.mockImplementation(() => {});
    mockGenerateText.mockReset();
    mockGenerateText.mockImplementation(async () => ({ text: "Hook title" }));
    setLlmAdapterForTest({ generateText: mockGenerateText as unknown as typeof import("ai").generateText });
    await rm(TEST_TMP, { recursive: true, force: true });
    await mkdir(TEST_TMP, { recursive: true });
    __setSessionsDirForTest(() => TEST_TMP);
  });

  afterEach(async () => {
    try {
      await Promise.all([...sessionIds].map((sessionId) => storeManager.flushSession(sessionId, WORKSPACE_ROOT)));
    } finally {
      sessionIds.clear();
      storeManager.clearAll();
      setLlmAdapterForTest(undefined);
      __setSessionsDirForTest(undefined);
    }
  });

  afterAll(async () => {
    __setSessionsDirForTest(undefined);
    await rm(TEST_TMP, { recursive: true, force: true });
  });

  test("dispatches title-generation on first model call when no title set", async () => {
    const store = createStore();

    const ctx: BeforeModelCallContext = {
      store,
      binding: makeBinding(),
      logger: silentLogger,
      messages: [],
    };
    const hook = createTitleGenerationHook(mockBtm as never, WORKSPACE_ROOT);
    await hook(ctx);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith(
      "title-generation",
      expect.any(Function),
    );
  });

  test("skips dispatch when title already set", async () => {
    const store = createStore();
    store.setState({ title: "Already titled" });

    const ctx: BeforeModelCallContext = {
      store,
      binding: makeBinding(),
      logger: silentLogger,
      messages: [],
    };
    const hook = createTitleGenerationHook(mockBtm as never, WORKSPACE_ROOT);
    await hook(ctx);

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test("only dispatches once (triggered guard)", async () => {
    const store = createStore();

    const ctx: BeforeModelCallContext = {
      store,
      binding: makeBinding(),
      logger: silentLogger,
      messages: [],
    };
    const hook = createTitleGenerationHook(mockBtm as never, WORKSPACE_ROOT);

    await hook(ctx);
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    mockDispatch.mockReset();
    await hook(ctx);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test("passes modelOptions to dispatched title generation task", async () => {
    const store = createStore();
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
      binding: makeBinding(modelOptions),
      logger: silentLogger,
      messages: [],
    };

    const hook = createTitleGenerationHook(mockBtm as never, WORKSPACE_ROOT);
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

  test("dispatched title generation persists title metadata", async () => {
    const sessionId = crypto.randomUUID();
    const store = createStore(sessionId);
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
              text: "Persist a title from generation",
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
      binding: makeBinding(),
      logger: silentLogger,
      messages: [],
    };

    const hook = createTitleGenerationHook(mockBtm as never, WORKSPACE_ROOT);
    await hook(ctx);

    const dispatchRun = mockDispatch.mock.calls[0]![1];
    await dispatchRun();

    expect(store.getState().title).toBe("Hook title");
    await storeManager.flushSession(sessionId, WORKSPACE_ROOT);
    const persisted = JSON.parse(
      await Bun.file(join(TEST_TMP, sessionId, "session.json")).text(),
    ) as { title?: string | null };
    expect(persisted.title).toBe("Hook title");
  });
});
