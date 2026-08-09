import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestedModelSelection } from "@archcode/protocol";
import { ServerConfigService, resolveServerConfigPath } from "./config";
import { silentLogger } from "./logger";
import { ProjectRegistry } from "./projects/registry";
import { createRuntime as createProductionRuntime } from "./runtime";
import { sessionFileInternals } from "./store/helpers";
import { createTestMcpRuntime } from "./testing/test-mcp-runtime";

const tmpRoots: string[] = [];
const requestedModelSelection: RequestedModelSelection = {
  mode: "profile_default",
  selection: { model: "local:test-model" },
};

afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "archcode-runtime-skill-command-"));
  tmpRoots.push(root);
  return root;
}

async function createRuntime() {
  const configHome = await makeTempRoot();
  const configPath = resolveServerConfigPath(configHome);
  await mkdir(join(configHome, ".archcode"), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    provider: {
      local: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local LLM",
        options: { baseURL: "http://localhost:8090/v1", apiKey: "test-key" },
        models: {
          "test-model": {
            name: "Test Model",
            limit: { context: 128000, output: 8192 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
    profiles: {
      principal: { model: "local:test-model" },
      deep: { model: "local:test-model" },
      fast: { model: "local:test-model" },
    },
    mcp: { servers: {} },
  }));
  const configService = new ServerConfigService({ homeDir: configHome });
  const activation = await configService.activateForStartup();
  if (activation.status !== "ready") throw new Error(`Expected ready config, received ${activation.status}`);
  const runtimeStorageHomeDir = await makeTempRoot();
  return await createProductionRuntime({
    configService,
    activation: activation.activation,
    projectRegistry: new ProjectRegistry({ homeDir: runtimeStorageHomeDir, logger: silentLogger }),
    runtimeStorageHomeDir,
    mcpRuntimeFactory: () => createTestMcpRuntime(),
    logger: silentLogger,
  });
}

describe("runtime Skill command admission", () => {
  test("admits a custom Skill outside the Agent builtin allow-list and replays its normalized activation", async () => {
    const workspaceRoot = await makeTempRoot();
    const skillName = "custom-explicit-skill";
    const skillRoot = join(workspaceRoot, ".archcode", "skills", skillName);
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), [
      "---",
      `name: ${skillName}`,
      "description: Explicit custom Skill outside the Lead builtin allow-list.",
      "---",
      "",
      "CUSTOM_EXPLICIT_SKILL_BODY",
      "",
    ].join("\n"));
    const runtime = await createRuntime();
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Skill command" });
    const session = await runtime.createSession(workspaceRoot, {
      agentName: "lead",
      source: { kind: "direct" },
    });
    const clientRequestId = crypto.randomUUID();
    const persistedReceiptStates: Array<Array<{ kind: string; status: string }>> = [];
    const originalSave = sessionFileInternals.saveSessionTranscript;
    sessionFileInternals.saveSessionTranscript = async (state, root) => {
      const matching = state.inputRequestReceipts.filter(
        (receipt) => receipt.clientRequestId === clientRequestId,
      );
      if (matching.length > 0) {
        persistedReceiptStates.push(matching.map(({ kind, status }) => ({ kind, status })));
      }
      await originalSave(state, root);
    };

    try {
      const base = {
        slug: project.slug,
        workspaceRoot,
        sessionId: session.sessionId,
        attachmentIds: [],
        clientRequestId,
        source: "user" as const,
        requestedModelSelection,
      };
      const accepted = await runtime.acceptSessionMessage({
        ...base,
        text: `/skill   use   ${skillName}   inspect   changes`,
      });
      const replayed = await runtime.acceptSessionMessage({
        ...base,
        text: `/skill use ${skillName} inspect changes`,
      });
      expect(replayed).toEqual(accepted);
      if (accepted.status === "command") throw new Error("Expected a pending Skill message");
      await expect(runtime.acceptSessionMessage({
        ...base,
        text: "/skill use codemap inspect",
      })).rejects.toMatchObject({ reason: "idempotency" });

      const file = await runtime.getSessionFile(workspaceRoot, session.sessionId);
      expect(file.inputRequestReceipts).toEqual([
        expect.objectContaining({ kind: "message", clientRequestId, messageId: accepted.messageId }),
      ]);
      expect(file.messages
        .filter((message) => message.role === "user")
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.text)).toContain("inspect changes");
      expect(persistedReceiptStates[0]).toEqual([{ kind: "message", status: "pending" }]);
      expect(persistedReceiptStates.every((receipts) => receipts.every(
        ({ kind, status }) => kind === "message" && status !== "executing",
      ))).toBeTrue();
    } finally {
      sessionFileInternals.saveSessionTranscript = originalSave;
      await runtime.abortAllSessionExecutions();
      await runtime.shutdown();
    }
  });

  test("projects a Session-scoped catalog from persisted Agent policy", async () => {
    const workspaceRoot = await makeTempRoot();
    const skillName = "custom-session-catalog";
    const skillRoot = join(workspaceRoot, ".archcode", "skills", skillName);
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), [
      "---",
      `name: ${skillName}`,
      "description: Custom Session catalog fixture.",
      "---",
      "",
      "CUSTOM_SESSION_CATALOG_BODY",
      "",
    ].join("\n"));
    const runtime = await createRuntime();
    const session = await runtime.createSession(workspaceRoot, {
      agentName: "lead",
      source: { kind: "direct" },
    });

    try {
      const catalog = await runtime.getSessionSkillCatalog(workspaceRoot, session.sessionId);

      expect(catalog.items).toContainEqual({
        name: skillName,
        source: "project-archcode",
        winner: true,
        shadowed: false,
        valid: true,
        description: "Custom Session catalog fixture.",
      });
      expect(catalog.items.some((item) => item.name === "git-master" && item.source === "builtin")).toBeTrue();
      expect(catalog.items.some((item) => item.name === "shape-todo" && item.source === "builtin")).toBeFalse();
      expect(catalog.promptProjection.includedEntries).toContainEqual({
        name: skillName,
        description: "Custom Session catalog fixture.",
        source: "project-archcode",
      });
      expect(Object.keys(catalog.items.find((item) => item.name === skillName)!).sort()).toEqual([
        "description",
        "name",
        "shadowed",
        "source",
        "valid",
        "winner",
      ]);
    } finally {
      await runtime.abortAllSessionExecutions();
      await runtime.shutdown();
    }
  });
});
