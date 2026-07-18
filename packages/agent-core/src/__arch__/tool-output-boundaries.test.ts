import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const srcRoot = resolve(import.meta.dir, "..");

function source(relativePath: string): string {
  return readFileSync(join(srcRoot, relativePath), "utf8");
}

function productionFiles(directory = srcRoot): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      return entry === "__arch__" || entry === "__test_tmp__" ? [] : productionFiles(path);
    }
    return /\.ts$/.test(entry) && !/\.(?:test|integration)\.ts$/.test(entry) ? [path] : [];
  });
}

describe("tool output ownership boundaries", () => {
  test("the package API exposes bounded recovery but no raw artifact creation", () => {
    const rootIndex = source("index.ts");
    const outputIndex = source("tool-output/index.ts");
    const runtime = source("runtime.ts");
    const publicRuntimeOptions = runtime.slice(
      runtime.indexOf("export interface AgentRuntimeOptions"),
      runtime.indexOf("interface AgentRuntimeInternalOptions"),
    );
    const forbidden = [
      "ToolOutputArtifactStore",
      "ArtifactStoreOptions",
      "CreateArtifactInput",
      "CreatedArtifact",
      "BeginCaptureInput",
      "ToolOutputCapture",
      "ToolOutputFinalizer",
      "FinalizeRawToolResultInput",
    ];

    expect(rootIndex).toContain('export * from "./tool-output"');
    expect(outputIndex).not.toMatch(/export\s+\*\s+from/);
    for (const name of forbidden) {
      expect(outputIndex).not.toContain(name);
      expect(rootIndex).not.toMatch(new RegExp(`export[^;]*\\b${name}\\b`));
      expect(publicRuntimeOptions).not.toContain(name);
    }
    expect(outputIndex).toContain("ToolOutputAccessService");
    expect(outputIndex).toContain("ToolOutputError");
  });

  test("production creation has one Registry to Finalizer to capture commit path", () => {
    const calls = productionFiles().flatMap((file) => {
      const text = readFileSync(file, "utf8");
      const matches = [
        ...text.matchAll(/\bthis\.#finalizer\.beginCapture\s*\(/g),
        ...text.matchAll(/\bthis\.#artifactStore\.beginCapture\s*\(/g),
        ...text.matchAll(/\bcapture\.commit\s*\(\s*completed\s*\)/g),
      ];
      return matches.map((match) => `${relative(srcRoot, file)}:${match[0]}`);
    });
    expect(calls.sort()).toEqual([
      "tool-output/finalizer.ts:capture.commit(completed)",
      "tool-output/finalizer.ts:this.#artifactStore.beginCapture(",
      "tools/registry.ts:this.#finalizer.beginCapture(",
    ]);

    const rawCallViolations = productionFiles().flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return /[.#]createFixtureArtifact\s*\(/.test(text)
        || /\.create\s*\(\s*\{[\s\S]{0,512}?\bcanonical\s*:/.test(text)
        ? [relative(srcRoot, file)]
        : [];
    });
    expect(rawCallViolations).toEqual([]);
  });

  test("shared redaction is low-level and the old tool-layer path is gone", () => {
    expect(existsSync(join(srcRoot, "security/redaction.ts"))).toBe(true);
    const retiredRedactionPath = ["tools", "security", "redaction"].join("/");
    expect(existsSync(join(srcRoot, `${retiredRedactionPath}.ts`))).toBe(false);
    expect(existsSync(join(srcRoot, `${retiredRedactionPath}.test.ts`))).toBe(false);
    expect(source("security/redaction.ts")).not.toMatch(/from\s+["'][^"']*(?:tool-output|tools)\//);
    expect(source("tools/security/index.ts")).not.toMatch(
      /redactString|redactValue|REDACTION_MARKER|SecretRedactionPolicy/,
    );

    const legacyImports = productionFiles(srcRoot).flatMap((file) => (
      readFileSync(file, "utf8").includes(retiredRedactionPath)
        ? [relative(srcRoot, file)]
        : []
    ));
    expect(legacyImports).toEqual([]);
  });

  test("artifact serialization uses a semantic lock capability", () => {
    const artifactStore = source("tool-output/artifact-store.ts");
    expect(artifactStore).toContain("async withLock<T>");
    expect(artifactStore).not.toMatch(/\bmutex\.run\s*\(/);
  });
});
