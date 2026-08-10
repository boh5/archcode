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

  test("Bash live projection and terminal settlement each have one production owner", () => {
    const production = productionFiles().map((file) => ({
      file: relative(srcRoot, file),
      text: readFileSync(file, "utf8"),
    }));

    const durableEventOwners = production.flatMap(({ file, text }) => (
      /events:\s*\[\s*\{\s*type:\s*["']tool-result["']/.test(text) ? [file] : []
    ));
    expect(durableEventOwners).toEqual(["execution/session-tool-batch-scheduler.ts"]);

    const directAppendOwners = production.flatMap(({ file, text }) => (
      /\.append\s*\(\s*\{\s*type:\s*["']tool-result["']/.test(text) ? [file] : []
    ));
    expect(directAppendOwners).toEqual([]);

    const liveAppendOwners = production.flatMap(({ file, text }) => (
      /\.append\s*\(\s*\{\s*type:\s*["']tool-output-delta["']/.test(text) ? [file] : []
    ));
    expect(liveAppendOwners).toEqual(["tool-output/live-publisher.ts"]);

    const liveCaptureSources = production.flatMap(({ file, text }) => (
      /\bcapture\.write\s*\([\s\S]{0,160}?source:\s*["']bash-live["']/.test(text) ? [file] : []
    ));
    expect(liveCaptureSources).toEqual(["tools/builtins/bash.ts"]);
  });

  test("tool input and output ownership is independent from security transforms", () => {
    expect(existsSync(join(srcRoot, "security/redaction.ts"))).toBe(true);
    expect(source("security/redaction.ts")).not.toMatch(/from\s+["'][^"']*(?:tool-output|tools)\//);
    expect(source("tools/security/index.ts")).not.toMatch(
      /redactString|redactValue|REDACTION_MARKER|SecretRedactionPolicy/,
    );
    for (const path of [
      "tool-output/finalizer.ts",
      "tool-output/capture.ts",
      "tools/registry.ts",
      "tools/errors.ts",
      "tools/hooks/audit.ts",
      "store/projection.ts",
    ]) {
      expect(source(path)).not.toMatch(
        /SecretRedactionPolicy|REDACTION_MARKER|\bredactString\b|\bredactValue\b/,
      );
      expect(source(path)).not.toMatch(/from\s+["'][^"']*security(?:\/index)?["']/);
    }
  });

  test("artifact serialization uses a semantic lock capability", () => {
    const artifactStore = source("tool-output/artifact-store.ts");
    expect(artifactStore).toContain("async withLock<T>");
    expect(artifactStore).not.toMatch(/\bmutex\.run\s*\(/);
  });
});
