import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(120_000);

const repositoryRoot = join(import.meta.dir, "../../../..");
const fixturePath = join(repositoryRoot, "apps/web/public/favicon.ico");
const skillsEntrypoint = join(import.meta.dir, "index.ts");
const skillReadModule = join(import.meta.dir, "../tools/builtins/skill-read.ts");

test("standalone binary preserves real builtin resources and arbitrary embedded bytes", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "archcode-skill-standalone-"));
  try {
    const sourceFixtureBytes = await Bun.file(fixturePath).bytes();
    const sourceFixtureDigest = sha256(sourceFixtureBytes);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(sourceFixtureBytes)).toThrow();

    const entrypoint = join(tempRoot, "main.ts");
    const executable = join(tempRoot, "skill-smoke");
    await Bun.write(entrypoint, standaloneSource({
      fixturePath,
      skillsEntrypoint,
      skillReadModule,
    }));

    const compiler = Bun.spawn([
      "bun",
      "build",
      entrypoint,
      "--target=bun",
      "--minify",
      "--compile",
      `--outfile=${executable}`,
    ], {
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [compileExitCode, compileStdout, compileStderr] = await Promise.all([
      compiler.exited,
      new Response(compiler.stdout).text(),
      new Response(compiler.stderr).text(),
    ]);
    if (compileExitCode !== 0) {
      throw new Error([
        `Standalone Skill smoke compilation exited ${compileExitCode}`,
        compileStdout,
        compileStderr,
      ].filter(Boolean).join("\n"));
    }

    const process = Bun.spawn([executable], {
      cwd: tempRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: {},
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const result = JSON.parse(stdout) as StandaloneResult;
    expect(result).toMatchObject({
      builtinSource: "builtin",
      builtinResource: "references/evidence-map-example.md",
      builtinTextFound: true,
      fixtureBytes: sourceFixtureBytes.byteLength,
      fixtureDigest: sourceFixtureDigest,
      serviceDigest: sourceFixtureDigest,
      unsupportedError: true,
      unsupportedCode: "TOOL_SKILL_RESOURCE_BINARY_UNSUPPORTED",
    });
    expect(result.unsupportedText).toBe([
      "---",
      "skill: binary-fixture",
      "source: builtin",
      "resource: assets/favicon.ico",
      `bytes: ${sourceFixtureBytes.byteLength}`,
      "---",
      "",
      "error: TOOL_SKILL_RESOURCE_BINARY_UNSUPPORTED",
      "hint: Binary Skill resources are valid package assets but cannot be returned by the text-only skill_read tool.",
    ].join("\n"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

interface StandaloneResult {
  readonly builtinSource: string;
  readonly builtinResource: string;
  readonly builtinTextFound: boolean;
  readonly fixtureBytes: number;
  readonly fixtureDigest: string;
  readonly serviceDigest: string;
  readonly unsupportedError: boolean;
  readonly unsupportedCode?: string;
  readonly unsupportedText: string;
}

function standaloneSource(paths: {
  readonly fixturePath: string;
  readonly skillsEntrypoint: string;
  readonly skillReadModule: string;
}): string {
  return [
    `import embeddedFixturePath from ${JSON.stringify(paths.fixturePath)} with { type: "file" };`,
    `import { BUILTIN_SKILL_PACKAGES, SkillService } from ${JSON.stringify(paths.skillsEntrypoint)};`,
    `import { formatResolvedSkillResource } from ${JSON.stringify(paths.skillReadModule)};`,
    "",
    "const fixtureBytes = await Bun.file(embeddedFixturePath).bytes();",
    "const fixtureDigest = new Bun.CryptoHasher(\"sha256\").update(fixtureBytes).digest(\"hex\");",
    "const builtinSkills = {",
    "  ...BUILTIN_SKILL_PACKAGES,",
    "  \"binary-fixture\": {",
    "    entry: [",
    "      \"---\",",
    "      \"name: binary-fixture\",",
    "      \"description: Verifies arbitrary embedded bytes when standalone Skill packages are compiled.\",",
    "      \"---\",",
    "      \"\",",
    "      \"Read the binary fixture.\",",
    "    ].join(\"\\n\"),",
    "    resources: { \"assets/favicon.ico\": fixtureBytes },",
    "  },",
    "};",
    "const service = new SkillService({ userSkillsRoot: \"/definitely-missing-user-skills\", builtinSkills });",
    "const realResource = await service.readResourceForAgent(",
    "  \"/definitely-missing-project\",",
    "  \"codemap\",",
    "  \"references/evidence-map-example.md\",",
    "  [\"codemap\"],",
    ");",
    "if (realResource === null) throw new Error(\"real builtin resource was not resolved\");",
    "const binaryResource = await service.readResourceForAgent(",
    "  \"/definitely-missing-project\",",
    "  \"binary-fixture\",",
    "  \"assets/favicon.ico\",",
    "  [\"binary-fixture\"],",
    ");",
    "if (binaryResource === null) throw new Error(\"binary builtin resource was not resolved\");",
    "const serviceDigest = new Bun.CryptoHasher(\"sha256\").update(binaryResource.content).digest(\"hex\");",
    "const unsupported = formatResolvedSkillResource(binaryResource);",
    "const unsupportedText = unsupported.draft.kind === \"text\" ? unsupported.draft.text : \"\";",
    "console.log(JSON.stringify({",
    "  builtinSource: realResource.source,",
    "  builtinResource: realResource.resource.path,",
    "  builtinTextFound: new TextDecoder().decode(realResource.content).includes(\"Evidence map shape\"),",
    "  fixtureBytes: fixtureBytes.byteLength,",
    "  fixtureDigest,",
    "  serviceDigest,",
    "  unsupportedError: unsupported.isError,",
    "  unsupportedCode: unsupported.details?.error?.code,",
    "  unsupportedText,",
    "}));",
    "",
  ].join("\n");
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}
