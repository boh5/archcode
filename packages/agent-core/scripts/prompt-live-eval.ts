import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getModelConfig } from "../src/config/provider";
import { ServerConfigService } from "../src/config/server-config-service";
import { runLlmText } from "../src/llm";
import { createRegistry } from "../src/provider";
import { PromptLiveEvalManifestSchema, PromptLiveEvalScenariosSchema, runPromptLiveEval } from "../src/prompt/live-eval";

if (process.env.ARCHCODE_PROMPT_LIVE_EVAL !== "1") {
  throw new Error("Live eval is opt-in. Set ARCHCODE_PROMPT_LIVE_EVAL=1 explicitly.");
}

const manifestFlag = process.argv.indexOf("--manifest");
const manifestArgument = manifestFlag < 0 ? undefined : process.argv[manifestFlag + 1];
if (manifestArgument === undefined) throw new Error("Usage: bun run prompt:live-eval -- --manifest <manifest.json>");
const homeDirFlag = process.argv.indexOf("--home-dir");
const homeDirArgument = homeDirFlag < 0 ? undefined : process.argv[homeDirFlag + 1];

const manifestPath = resolve(manifestArgument);
const fixturePath = resolve(import.meta.dir, "../src/prompt/live-eval-scenarios.json");
const manifest = PromptLiveEvalManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
const fixture = PromptLiveEvalScenariosSchema.parse(JSON.parse(await readFile(fixturePath, "utf8")));
const configService = new ServerConfigService(homeDirArgument === undefined ? {} : { homeDir: resolve(homeDirArgument) });
const config = await configService.loadForStartup();
const registry = createRegistry(config.provider);
const result = await runPromptLiveEval(manifest, fixture, async (qualifiedId, system, prompt) => {
  const model = registry.getModel(qualifiedId);
  const provider = config.provider[model.providerId];
  if (provider === undefined) throw new Error(`Manifest model provider is not configured: ${model.providerId}`);
  const modelOptions = getModelConfig(provider, model.modelId).options;
  return (await runLlmText({
    model: model.model,
    modelOptions,
    system,
    prompt,
    redactSensitiveText: (text) => model.redactSensitiveText(text),
  })).text;
});
const resultPath = resolve(manifest.resultPath);
await mkdir(dirname(resultPath), { recursive: true });
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${resultPath}\n`);
