import { asSchema } from "@ai-sdk/provider-utils";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import { leadAgentDefinition } from "../src/agents/definitions";
import { registerBuiltinTools } from "../src/core/register-tools";
import { silentLogger } from "../src/logger";
import { createTestToolRegistryFixture } from "../src/tools/test-registry";

const EXPECTED_TOOL_COUNT = 34;

type OpenAICompatibleTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
};

function assertLeadToolSurface(
  expectedNames: readonly string[],
  actualNames: readonly string[],
): void {
  if (expectedNames.length !== EXPECTED_TOOL_COUNT) {
    throw new Error(
      `Lead definition must contain exactly ${EXPECTED_TOOL_COUNT} base tools; found ${expectedNames.length}.`,
    );
  }

  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      "Resolved Lead tools do not exactly match leadAgentDefinition order: " +
        JSON.stringify({ expectedNames, actualNames }),
    );
  }
}

async function buildLeadWire(): Promise<OpenAICompatibleTool[]> {
  const fixture = createTestToolRegistryFixture({ logger: silentLogger });
  const registry = fixture.registry;

  try {
    registerBuiltinTools(registry, silentLogger, { github: { enabled: false } });

    const expectedNames = leadAgentDefinition.tools.tools;
    const resolved = registry.resolveForAgent(expectedNames);
    const aiTools = resolved.toAITools();
    const actualNames = Object.keys(aiTools);

    assertLeadToolSurface(expectedNames, actualNames);

    return await Promise.all(
      expectedNames.map(async (name): Promise<OpenAICompatibleTool> => {
        const aiTool = aiTools[name];
        if (aiTool === undefined) {
          throw new Error(`Resolved Lead tool is missing: ${name}`);
        }

        return {
          type: "function",
          function: {
            name,
            description: aiTool.description,
            parameters: await asSchema(aiTool.inputSchema).jsonSchema,
          },
        };
      }),
    );
  } finally {
    await fixture.dispose();
  }
}

function minified(value: unknown): string {
  return JSON.stringify(value);
}

const wire = await buildLeadWire();
const tokenizer = new Tiktoken(o200kBase);
const countTokens = (value: unknown): number => tokenizer.encode(minified(value)).length;
const skeleton = wire.map(() => ({
  type: "function" as const,
  function: { name: "", description: "", parameters: {} },
}));

if (process.argv.includes("--wire")) {
  console.log(minified(wire));
} else {
  console.log(JSON.stringify({
    agent: "lead",
    tokenizer: "js-tiktoken@1.0.21/o200k_base",
    toolCount: wire.length,
    tokens: {
      full: countTokens(wire),
      names: countTokens(wire.map((tool) => tool.function.name)),
      descriptions: countTokens(wire.map((tool) => tool.function.description)),
      parameters: countTokens(wire.map((tool) => tool.function.parameters)),
      skeleton: countTokens(skeleton),
    },
  }, null, 2));
}
