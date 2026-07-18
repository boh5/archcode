import type { ProviderV3 } from "@ai-sdk/provider";
import type { ProviderAdapterCatalog as ProviderAdapterCatalogDto } from "@archcode/protocol";

const [
  { createAlibaba },
  { createAmazonBedrock },
  { createAnthropic },
  { createAzure },
  { createBaseten },
  { createCerebras },
  { createCohere },
  { createDeepInfra },
  { createDeepSeek },
  { createFireworks },
  { createGatewayProvider },
  { createGoogleGenerativeAI },
  { createVertex },
  { createGroq },
  { createHuggingFace },
  { createMistral },
  { createMoonshotAI },
  { createOpenResponses },
  { createOpenAICompatible },
  { createOpenAI },
  { createPerplexity },
  { createTogetherAI },
  { createVercel },
  { createXai },
] = await Promise.all([
  import("@ai-sdk/alibaba"),
  import("@ai-sdk/amazon-bedrock"),
  import("@ai-sdk/anthropic"),
  import("@ai-sdk/azure"),
  import("@ai-sdk/baseten"),
  import("@ai-sdk/cerebras"),
  import("@ai-sdk/cohere"),
  import("@ai-sdk/deepinfra"),
  import("@ai-sdk/deepseek"),
  import("@ai-sdk/fireworks"),
  import("@ai-sdk/gateway"),
  import("@ai-sdk/google"),
  import("@ai-sdk/google-vertex"),
  import("@ai-sdk/groq"),
  import("@ai-sdk/huggingface"),
  import("@ai-sdk/mistral"),
  import("@ai-sdk/moonshotai"),
  import("@ai-sdk/open-responses"),
  import("@ai-sdk/openai-compatible"),
  import("@ai-sdk/openai"),
  import("@ai-sdk/perplexity"),
  import("@ai-sdk/togetherai"),
  import("@ai-sdk/vercel"),
  import("@ai-sdk/xai"),
]);

export type JsonSafeProviderOptions = Readonly<Record<string, unknown>>;

export type ProviderOptionField = Readonly<{
  path: string;
  label: string;
  kind: "string" | "url" | "number" | "boolean" | "json";
  required?: boolean;
}>;

export type ProviderAdapter = Readonly<{
  npmPackage: string;
  displayName: string;
  optionFields: readonly ProviderOptionField[];
  secretPaths: readonly string[];
  /** Pure, observable input that create() hands unchanged to the SDK factory. */
  factoryInput(input: {
    providerId: string;
    options: JsonSafeProviderOptions;
  }): Readonly<Record<string, unknown>>;
  create(input: {
    providerId: string;
    options: JsonSafeProviderOptions;
  }): ProviderV3;
}>;

type ProviderAdapterDefinition = Readonly<{
  npmPackage: string;
  displayName: string;
  optionFields: readonly ProviderOptionField[];
  secretPaths: readonly string[];
  createFromFactoryInput(input: Readonly<Record<string, unknown>>): ProviderV3;
}>;

const apiKeyOption = {
  path: "apiKey",
  label: "API key",
  kind: "string",
} as const;
const baseUrlOption = {
  path: "baseURL",
  label: "Base URL",
  kind: "url",
} as const;
const headersOption = {
  path: "headers",
  label: "Headers",
  kind: "json",
} as const;
const queryParamsOption = {
  path: "queryParams",
  label: "Query parameters",
  kind: "json",
} as const;
const apiKeyAndTransportSecrets = [
  "apiKey",
  "headers.*",
] as const;
const openAiCompatibleSecrets = [
  ...apiKeyAndTransportSecrets,
  "queryParams.*",
] as const;
const NAMED_FACTORY_PACKAGES = new Set([
  "@ai-sdk/open-responses",
  "@ai-sdk/openai-compatible",
]);

function fields(...fields: ProviderOptionField[]): readonly ProviderOptionField[] {
  return fields;
}

function optionsForFactory(
  options: JsonSafeProviderOptions,
  providerId?: string,
): Record<string, unknown> {
  return providerId === undefined ? { ...options } : { ...options, name: providerId };
}

function prepareFactoryInput(
  npmPackage: string,
  input: { providerId: string; options: JsonSafeProviderOptions },
): Readonly<Record<string, unknown>> {
  return optionsForFactory(
    input.options,
    NAMED_FACTORY_PACKAGES.has(npmPackage) ? input.providerId : undefined,
  );
}

function requiredOptionValue(
  options: JsonSafeProviderOptions,
  field: ProviderOptionField,
): unknown {
  return field.path.split(".").reduce<unknown>((value, segment) => {
    if (value === null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[segment];
  }, options);
}

export class MissingProviderOptionError extends Error {
  constructor(
    public readonly npmPackage: string,
    public readonly optionPath: string,
  ) {
    super(`Provider "${npmPackage}" requires option "${optionPath}".`);
    this.name = "MissingProviderOptionError";
  }
}

export class UnsupportedProviderOptionError extends Error {
  constructor(
    public readonly npmPackage: string,
    public readonly optionPath: string,
  ) {
    super(`Provider "${npmPackage}" does not support option "${optionPath}".`);
    this.name = "UnsupportedProviderOptionError";
  }
}

export function validateProviderAdapterOptions(
  adapter: Pick<ProviderAdapter, "npmPackage" | "optionFields">,
  options: JsonSafeProviderOptions,
): void {
  if (
    options.queryParams !== undefined
    && !adapter.optionFields.some((field) => field.path === "queryParams")
  ) {
    throw new UnsupportedProviderOptionError(adapter.npmPackage, "queryParams");
  }
  if (options.name !== undefined && NAMED_FACTORY_PACKAGES.has(adapter.npmPackage)) {
    throw new UnsupportedProviderOptionError(adapter.npmPackage, "name");
  }
  for (const field of adapter.optionFields) {
    const value = requiredOptionValue(options, field);
    if (value === undefined) {
      if (!field.required) continue;
      throw new MissingProviderOptionError(adapter.npmPackage, field.path);
    }
    if (field.kind === "string" && (typeof value !== "string" || value.trim().length === 0)) {
      throw new MissingProviderOptionError(adapter.npmPackage, field.path);
    }
    if (field.kind === "url") {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new MissingProviderOptionError(adapter.npmPackage, field.path);
      }
      try {
        const parsed = new URL(value);
        if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
          throw new Error("Provider URL options must not contain credentials, query parameters, or fragments");
        }
      } catch {
        throw new MissingProviderOptionError(adapter.npmPackage, field.path);
      }
    }
    if (field.kind === "number" && typeof value !== "number") {
      throw new MissingProviderOptionError(adapter.npmPackage, field.path);
    }
    if (field.kind === "boolean" && typeof value !== "boolean") {
      throw new MissingProviderOptionError(adapter.npmPackage, field.path);
    }
  }
}

export function collectProviderSecretValues(
  adapter: Pick<ProviderAdapter, "secretPaths">,
  options: JsonSafeProviderOptions,
): readonly string[] {
  const values: string[] = [];
  for (const secretPath of adapter.secretPaths) {
    if (secretPath.endsWith(".*")) {
      const record = requiredOptionValue(options, {
        path: secretPath.slice(0, -2),
        label: secretPath,
        kind: "json",
      });
      if (record !== null && typeof record === "object" && !Array.isArray(record)) {
        for (const value of Object.values(record)) {
          if (typeof value === "string") values.push(value);
        }
      }
      continue;
    }
    const value = requiredOptionValue(options, {
      path: secretPath,
      label: secretPath,
      kind: "string",
    });
    if (typeof value === "string") values.push(value);
  }
  return Object.freeze(values);
}

const adapters = [
  {
    npmPackage: "@ai-sdk/gateway",
    displayName: "AI Gateway",
    optionFields: fields(apiKeyOption, baseUrlOption, headersOption),
    secretPaths: apiKeyAndTransportSecrets,
    createFromFactoryInput: (factoryInput) =>
      createGatewayProvider(
        factoryInput as Parameters<typeof createGatewayProvider>[0],
      ),
  },
  {
    npmPackage: "@ai-sdk/xai",
    displayName: "xAI",
    optionFields: fields(apiKeyOption, baseUrlOption, headersOption),
    secretPaths: apiKeyAndTransportSecrets,
    createFromFactoryInput: (factoryInput) =>
      createXai(factoryInput as Parameters<typeof createXai>[0]),
  },
  {
    npmPackage: "@ai-sdk/vercel",
    displayName: "Vercel AI",
    optionFields: fields(apiKeyOption, baseUrlOption, headersOption),
    secretPaths: apiKeyAndTransportSecrets,
    createFromFactoryInput: (factoryInput) =>
      createVercel(factoryInput as Parameters<typeof createVercel>[0]),
  },
  {
    npmPackage: "@ai-sdk/openai",
    displayName: "OpenAI",
    optionFields: fields(apiKeyOption, baseUrlOption, headersOption),
    secretPaths: apiKeyAndTransportSecrets,
    createFromFactoryInput: (factoryInput) =>
      createOpenAI(factoryInput as Parameters<typeof createOpenAI>[0]),
  },
  {
    npmPackage: "@ai-sdk/azure",
    displayName: "Azure OpenAI",
    optionFields: fields(apiKeyOption, baseUrlOption, headersOption),
    secretPaths: apiKeyAndTransportSecrets,
    createFromFactoryInput: (factoryInput) =>
      createAzure(factoryInput as Parameters<typeof createAzure>[0]),
  },
  {
    npmPackage: "@ai-sdk/anthropic",
    displayName: "Anthropic",
    optionFields: fields(apiKeyOption, baseUrlOption, headersOption),
    secretPaths: apiKeyAndTransportSecrets,
    createFromFactoryInput: (factoryInput) =>
      createAnthropic(
        factoryInput as Parameters<typeof createAnthropic>[0],
      ),
  },
  {
    npmPackage: "@ai-sdk/open-responses",
    displayName: "Open Responses",
    optionFields: fields(
      { path: "url", label: "Responses URL", kind: "url", required: true },
      apiKeyOption,
      headersOption,
    ),
    secretPaths: apiKeyAndTransportSecrets,
    createFromFactoryInput: (factoryInput) =>
      createOpenResponses(
        factoryInput as unknown as Parameters<typeof createOpenResponses>[0],
      ),
  },
  {
    npmPackage: "@ai-sdk/amazon-bedrock",
    displayName: "Amazon Bedrock",
    optionFields: fields(
      { path: "region", label: "AWS region", kind: "string" },
      apiKeyOption,
      baseUrlOption,
      headersOption,
      { path: "accessKeyId", label: "Access key ID", kind: "string" },
      { path: "secretAccessKey", label: "Secret access key", kind: "string" },
      { path: "sessionToken", label: "Session token", kind: "string" },
    ),
    secretPaths: [
      "apiKey",
      "accessKeyId",
      "secretAccessKey",
      "sessionToken",
      "headers.*",
    ],
    createFromFactoryInput: (factoryInput) =>
      createAmazonBedrock(
        factoryInput as Parameters<typeof createAmazonBedrock>[0],
      ),
  },
  {
    npmPackage: "@ai-sdk/groq",
    displayName: "Groq",
    optionFields: fields(apiKeyOption, baseUrlOption, headersOption),
    secretPaths: apiKeyAndTransportSecrets,
    createFromFactoryInput: (factoryInput) =>
      createGroq(factoryInput as Parameters<typeof createGroq>[0]),
  },
  {
    npmPackage: "@ai-sdk/deepinfra",
    displayName: "DeepInfra",
    optionFields: fields(apiKeyOption, baseUrlOption, headersOption),
    secretPaths: apiKeyAndTransportSecrets,
    createFromFactoryInput: (factoryInput) =>
      createDeepInfra(
        factoryInput as Parameters<typeof createDeepInfra>[0],
      ),
  },
  {
    npmPackage: "@ai-sdk/google",
    displayName: "Google AI",
    optionFields: fields(apiKeyOption, baseUrlOption, headersOption),
    secretPaths: apiKeyAndTransportSecrets,
    createFromFactoryInput: (factoryInput) =>
      createGoogleGenerativeAI(
        factoryInput as Parameters<typeof createGoogleGenerativeAI>[0],
      ),
  },
  {
    npmPackage: "@ai-sdk/google-vertex",
    displayName: "Google Vertex AI",
    optionFields: fields(
      { path: "project", label: "Google Cloud project", kind: "string" },
      { path: "location", label: "Location", kind: "string" },
      {
        path: "googleAuthOptions.credentials.private_key",
        label: "Service account private key",
        kind: "string",
      },
      apiKeyOption,
      baseUrlOption,
      headersOption,
    ),
    secretPaths: [
      "apiKey",
      "googleAuthOptions.credentials.private_key",
      "headers.*",
    ],
    createFromFactoryInput: (factoryInput) =>
      createVertex(
        factoryInput as Parameters<typeof createVertex>[0],
      ),
  },
  {
    npmPackage: "@ai-sdk/mistral",
    displayName: "Mistral",
    optionFields: fields(apiKeyOption, baseUrlOption, headersOption),
    secretPaths: apiKeyAndTransportSecrets,
    createFromFactoryInput: (factoryInput) =>
      createMistral(
        factoryInput as Parameters<typeof createMistral>[0],
      ),
  },
  {
    npmPackage: "@ai-sdk/togetherai",
    displayName: "Together AI",
    optionFields: fields(apiKeyOption, baseUrlOption, headersOption),
    secretPaths: apiKeyAndTransportSecrets,
    createFromFactoryInput: (factoryInput) =>
      createTogetherAI(
        factoryInput as Parameters<typeof createTogetherAI>[0],
      ),
  },
  {
    npmPackage: "@ai-sdk/cohere",
    displayName: "Cohere",
    optionFields: fields(apiKeyOption, baseUrlOption, headersOption),
    secretPaths: apiKeyAndTransportSecrets,
    createFromFactoryInput: (factoryInput) =>
      createCohere(
        factoryInput as Parameters<typeof createCohere>[0],
      ),
  },
  {
    npmPackage: "@ai-sdk/fireworks",
    displayName: "Fireworks AI",
    optionFields: fields(apiKeyOption, baseUrlOption, headersOption),
    secretPaths: apiKeyAndTransportSecrets,
    createFromFactoryInput: (factoryInput) =>
      createFireworks(
        factoryInput as Parameters<typeof createFireworks>[0],
      ),
  },
  {
    npmPackage: "@ai-sdk/deepseek",
    displayName: "DeepSeek",
    optionFields: fields(apiKeyOption, baseUrlOption, headersOption),
    secretPaths: apiKeyAndTransportSecrets,
    createFromFactoryInput: (factoryInput) =>
      createDeepSeek(
        factoryInput as Parameters<typeof createDeepSeek>[0],
      ),
  },
  {
    npmPackage: "@ai-sdk/moonshotai",
    displayName: "Moonshot AI",
    optionFields: fields(apiKeyOption, baseUrlOption, headersOption),
    secretPaths: apiKeyAndTransportSecrets,
    createFromFactoryInput: (factoryInput) =>
      createMoonshotAI(
        factoryInput as Parameters<typeof createMoonshotAI>[0],
      ),
  },
  {
    npmPackage: "@ai-sdk/alibaba",
    displayName: "Alibaba Cloud",
    optionFields: fields(apiKeyOption, baseUrlOption, headersOption),
    secretPaths: apiKeyAndTransportSecrets,
    createFromFactoryInput: (factoryInput) =>
      createAlibaba(
        factoryInput as Parameters<typeof createAlibaba>[0],
      ),
  },
  {
    npmPackage: "@ai-sdk/cerebras",
    displayName: "Cerebras",
    optionFields: fields(apiKeyOption, baseUrlOption, headersOption),
    secretPaths: apiKeyAndTransportSecrets,
    createFromFactoryInput: (factoryInput) =>
      createCerebras(
        factoryInput as Parameters<typeof createCerebras>[0],
      ),
  },
  {
    npmPackage: "@ai-sdk/perplexity",
    displayName: "Perplexity",
    optionFields: fields(apiKeyOption, baseUrlOption, headersOption),
    secretPaths: apiKeyAndTransportSecrets,
    createFromFactoryInput: (factoryInput) =>
      createPerplexity(
        factoryInput as Parameters<typeof createPerplexity>[0],
      ),
  },
  {
    npmPackage: "@ai-sdk/baseten",
    displayName: "Baseten",
    optionFields: fields(apiKeyOption, baseUrlOption, headersOption),
    secretPaths: apiKeyAndTransportSecrets,
    createFromFactoryInput: (factoryInput) =>
      createBaseten(
        factoryInput as Parameters<typeof createBaseten>[0],
      ),
  },
  {
    npmPackage: "@ai-sdk/huggingface",
    displayName: "Hugging Face",
    optionFields: fields(apiKeyOption, baseUrlOption, headersOption),
    secretPaths: apiKeyAndTransportSecrets,
    createFromFactoryInput: (factoryInput) =>
      createHuggingFace(
        factoryInput as Parameters<typeof createHuggingFace>[0],
      ),
  },
  {
    npmPackage: "@ai-sdk/openai-compatible",
    displayName: "OpenAI-compatible",
    optionFields: fields(
      { ...baseUrlOption, required: true },
      apiKeyOption,
      headersOption,
      queryParamsOption,
    ),
    secretPaths: openAiCompatibleSecrets,
    createFromFactoryInput: (factoryInput) =>
      createOpenAICompatible(
        factoryInput as unknown as Parameters<typeof createOpenAICompatible>[0],
      ),
  },
] satisfies readonly ProviderAdapterDefinition[];

export class ProviderAdapterCatalog {
  readonly #byPackage: ReadonlyMap<string, ProviderAdapter>;
  readonly #entries: readonly ProviderAdapter[];

  constructor(entries: readonly ProviderAdapterDefinition[]) {
    const packageNames = new Set<string>();
    for (const entry of entries) {
      if (packageNames.has(entry.npmPackage)) {
        throw new Error(`Duplicate provider adapter package: "${entry.npmPackage}".`);
      }
      packageNames.add(entry.npmPackage);
    }
    this.#entries = entries.map((entry) => ({
      npmPackage: entry.npmPackage,
      displayName: entry.displayName,
      optionFields: entry.optionFields,
      secretPaths: entry.secretPaths,
      factoryInput: (input) => prepareFactoryInput(entry.npmPackage, input),
      create: (input) => {
        validateProviderAdapterOptions(entry, input.options);
        const factoryInput = prepareFactoryInput(entry.npmPackage, input);
        return entry.createFromFactoryInput(factoryInput);
      },
    }));
    this.#byPackage = new Map(
      this.#entries.map((entry) => [entry.npmPackage, entry]),
    );
  }

  list(): readonly ProviderAdapter[] {
    return this.#entries;
  }

  get(npmPackage: string): ProviderAdapter | undefined {
    return this.#byPackage.get(npmPackage);
  }

  toDto(): ProviderAdapterCatalogDto {
    return this.#entries.map((adapter) => ({
      npmPackage: adapter.npmPackage,
      displayName: adapter.displayName,
      fields: adapter.optionFields.map((field) => ({
        path: field.path,
        label: field.label,
        kind: field.kind,
        required: field.required === true,
        secret: adapter.secretPaths.some((secretPath) =>
          secretPath === field.path || secretPath.startsWith(`${field.path}.`),
        ),
      })),
    }));
  }
}

export const providerAdapterCatalog = new ProviderAdapterCatalog(adapters);
