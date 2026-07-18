import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createInMemoryLogger } from "../../logger";
import { parseConfig } from "../../config";
import { createRegistry as createProviderRegistry } from "../../provider";
import { SkillService } from "../../skills";
import { storeManager } from "../../store/store";
import { createRegistry as createToolRegistry } from "../../tools";
import { createTestProjectContext } from "../../tools/test-project-context";
import { createTestTempRoot } from "../../testing/test-temp-root";
import type { ExecutionModelBinding } from "../../models";
import { runQueryLoop } from "./loop";

const testRoot = createTestTempRoot("provider-secret-redaction");
const HEADER_SECRET = "header secret+&";
const QUERY_SECRET = "query secret+&";

afterEach(() => storeManager.clearAll());
afterAll(async () => testRoot.cleanup());

describe("Provider secret redaction integration", () => {
  test("redacts a real OpenAI-compatible HTTP error echo from Store, SSE projection, result, and logs", async () => {
    let observedRequest = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        observedRequest = `${request.url} ${request.headers.get("x-provider-secret") ?? ""}`;
        return Response.json({
          error: {
            message: `Provider echoed ${observedRequest}`,
            code: `code-${HEADER_SECRET}`,
          },
        }, { status: 401 });
      },
    });

    try {
      const agent = { model: "echo:test-model" };
      const providers = parseConfig({
        provider: {
          echo: {
            npm: "@ai-sdk/openai-compatible",
            name: "Echo Provider",
            options: {
              baseURL: `http://127.0.0.1:${server.port}/v1`,
              apiKey: "test-api-key",
              headers: { "x-provider-secret": HEADER_SECRET },
              queryParams: { trace: QUERY_SECRET },
            },
            models: {
              "test-model": {
                name: "Echo Model",
                limit: { context: 8192, output: 1024 },
                modalities: { input: ["text"], output: ["text"] },
              },
            },
          },
        },
        agents: {
          engineer: agent,
          goal_lead: agent,
          plan: agent,
          build: agent,
          reviewer: agent,
          explore: agent,
          librarian: agent,
          shaper: agent,
        },
      }).provider;
      const modelInfo = createProviderRegistry(providers).getModel("echo:test-model");
      const binding: ExecutionModelBinding = {
        modelInfo,
        options: undefined,
        summary: {
          selection: { model: modelInfo.qualifiedId },
          providerId: modelInfo.providerId,
          modelId: modelInfo.modelId,
          providerDisplayName: modelInfo.providerDisplayName,
          modelDisplayName: modelInfo.displayName,
          resolution: "agent_default",
          modelRuntimeRevision: "integration-revision",
        },
      };
      const store = storeManager.create(crypto.randomUUID(), testRoot.path, { agentName: "engineer" });
      const messageId = crypto.randomUUID();
      store.getState().append({
        type: "session.messages_committed",
        executionId: `execution-${messageId}`,
        messages: [{
          id: messageId,
          clientRequestId: `request-${messageId}`,
          role: "user",
          parts: [{ type: "text", id: `${messageId}:text`, text: "trigger echo", createdAt: 1, completedAt: 1 }],
          createdAt: 1,
          completedAt: 1,
          executionId: `execution-${messageId}`,
        }],
      });
      const memoryLogger = createInMemoryLogger();

      const result = await runQueryLoop({
        binding,
        logger: memoryLogger.logger,
        toolRegistry: createToolRegistry(),
        store,
        allowedTools: [],
        agentSkills: [],
        skillService: new SkillService({ builtinSkills: {} }),
        storeManager,
        projectContext: createTestProjectContext(testRoot.path),
        cwd: testRoot.path,
        agentName: "engineer",
      });

      expect(observedRequest).toContain(HEADER_SECRET);
      expect(observedRequest).toContain(new URLSearchParams({ trace: QUERY_SECRET }).toString());
      const visible = JSON.stringify({
        result,
        events: store.getState().events,
        messages: store.getState().messages,
        modelMessages: store.getState().toModelMessages(),
        logs: memoryLogger.entries,
      });
      expect(result.status).toBe("failed");
      expect(visible).not.toContain(HEADER_SECRET);
      expect(visible).not.toContain(QUERY_SECRET);
      expect(visible).not.toContain(encodeURIComponent(HEADER_SECRET));
      expect(visible).not.toContain(encodeURIComponent(QUERY_SECRET));
      expect(visible).not.toContain(new URLSearchParams({ trace: QUERY_SECRET }).toString());
    } finally {
      server.stop(true);
    }
  });
});
