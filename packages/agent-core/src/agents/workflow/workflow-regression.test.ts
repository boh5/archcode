import { describe, expect, test } from "bun:test";

import { createRegistry } from "../../tools/registry";
import { registerBuiltinTools } from "../../core/register-tools";
import { storeManager } from "../../store/store";
import { WorkflowArtifactManager, WorkflowArtifactKindSchema, WorkflowStateManager } from "./index";
import { agentDefinitions } from "../definitions";
import { createAgentFactory } from "../factory";
import { ModelInfo } from "../../provider/model";
import { calculateReadyWave, parseTasksMarkdown, toggleTaskCheckbox, validateTasksMarkdown } from "./tasks-format";
import type { Registry as ProviderRegistry } from "../../provider";
import type { SpecraConfig } from "../../config/schema";
import { SkillService } from "../../skills";

const WORKFLOW_TOOL_NAMES = [
  "workflow_create",
  "workflow_read",
  "workflow_update_stage",
  "artifact_read",
  "artifact_write",
  "workflow_task_check",
] as const;

const WORKFLOW_AGENT_NAMES = [
  "product",
  "spec",
  "critic",
  "foreman",
  "builder",
  "reviewer",
  "librarian",
] as const;

describe("workflow regression hardening", () => {
  test("WorkflowArtifactKindSchema has no PLAN.md artifact kind", () => {
    const artifactKinds = WorkflowArtifactKindSchema.options;

    expect(artifactKinds).toEqual([
      "PRD",
      "SPEC",
      "TASKS",
      "CRITIC_REPORT",
      "EVIDENCE",
      "FINAL_REPORT",
    ]);
    expect(artifactKinds).not.toContain("PLAN");
  });

  test("registered tools include only workflow_* tools and no task_graph_* tools", () => {
    const registry = createRegistry();
    registerBuiltinTools(registry);
    const toolNames = registry.getAll().map((tool) => tool.name).sort();

    expect(WORKFLOW_TOOL_NAMES.every((name) => toolNames.includes(name))).toBe(true);
    expect(toolNames.filter((name) => name.startsWith("workflow_")).sort()).toEqual([
      "workflow_create",
      "workflow_read",
      "workflow_task_check",
      "workflow_update_stage",
    ]);
    expect(toolNames.filter((name) => name.startsWith("task_graph_"))).toEqual([]);
  });

  test("workflow agents use existing factory, registry, and session integration points", () => {
    const registry = createRegistry();
    registerBuiltinTools(registry);
    const providerRegistry = createProviderRegistry();
    const config = createConfigForAgents(providerRegistry.modelIds[0]!);
    const factory = createAgentFactory({
      definitions: agentDefinitions,
      providerRegistry,
      toolRegistry: registry,
      skillService: new SkillService({ builtinSkills: {} }),
      workspaceRoot: import.meta.dir,
      config,
    });

    for (const agentName of WORKFLOW_AGENT_NAMES) {
      const store = storeManager.create(`workflow-regression-${agentName}`);
      const agent = factory.createAgent(agentName, { store, depth: agentName === "builder" ? 2 : 1 });
      const definition = factory.getDefinition(agentName);
      const allowedTools = factory.resolveAllowedTools(definition, agentName === "builder" ? 2 : 1);

      expect(agent.store).toBe(store);
      expect(typeof agent.run).toBe("function");
      expect(registry.resolveForAgent(allowedTools).descriptors.map((tool) => tool.name)).toEqual(allowedTools);
    }

    expect(factory.getDelegateTargetsFor(factory.getDefinition("foreman"), 1)).toEqual(["builder", "reviewer"]);
    expect(factory.getDelegateTargetsFor(factory.getDefinition("builder"), 2)).toEqual(["explore", "librarian"]);
  });

  test("workflow code reuses shared filesystem, frontmatter, and TASKS.md helpers", async () => {
    const stateManager = new WorkflowStateManager(import.meta.dir);
    const artifactManager = new WorkflowArtifactManager(import.meta.dir, stateManager);
    const artifactProto = WorkflowArtifactManager.prototype;
    const stateProto = WorkflowStateManager.prototype;

    expect(artifactManager).toBeInstanceOf(WorkflowArtifactManager);
    expect(artifactProto.write).toBe(WorkflowArtifactManager.prototype.write);
    expect(artifactProto.read).toBe(WorkflowArtifactManager.prototype.read);
    expect(stateProto.create).toBe(WorkflowStateManager.prototype.create);
    expect(stateProto.readWorkflow).toBe(WorkflowStateManager.prototype.readWorkflow);

    const tasks = `# TASKS

- [ ] T1. Build slice

  Agent: builder
  Dependencies: none
  Description: Build one slice.
  Acceptance:
    - [ ] Slice exists
  QA:
    - [ ] Tests pass
`;
    const validation = validateTasksMarkdown(tasks);

    expect(validation.valid).toBe(true);
    expect(parseTasksMarkdown(tasks).map((task) => task.id)).toEqual(["T1"]);
    expect(calculateReadyWave(validation.tasks).map((task) => task.id)).toEqual(["T1"]);
    expect(toggleTaskCheckbox(tasks, "T1", true)).toContain("- [x] T1. Build slice");
  });
});

function createProviderRegistry(): ProviderRegistry {
  const modelInfo = new ModelInfo({
    model: {} as ConstructorParameters<typeof ModelInfo>[0]["model"],
    config: {
      name: "Workflow Regression Model",
      limit: { context: 1000, output: 100 },
      modalities: { input: ["text"], output: ["text"] },
    },
    providerId: "test",
    modelId: "workflow-regression",
  });

  return {
    sdkRegistry: {} as ProviderRegistry["sdkRegistry"],
    models: new Map([[modelInfo.qualifiedId, modelInfo]]),
    modelIds: [modelInfo.qualifiedId],
    getModel: (qualifiedId: string) => {
      if (qualifiedId === modelInfo.qualifiedId) return modelInfo;
      throw new Error(`Unexpected model lookup: ${qualifiedId}`);
    },
  } as ProviderRegistry;
}

function createConfigForAgents(model: string): SpecraConfig {
  return {
    provider: {},
    agents: Object.fromEntries(agentDefinitions.map((definition) => [definition.name, { model }])),
  } as SpecraConfig;
}
