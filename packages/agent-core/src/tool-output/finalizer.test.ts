import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { JsonValue } from "@archcode/protocol";

import { SkillService } from "../skills";
import { storeManager } from "../store/store";
import { createTestProjectContext } from "../tools/test-project-context";
import { createToolExecutionContext, type ToolDescriptor } from "../tools/types";
import { SecretRedactionPolicy } from "../security";
import { ToolOutputArtifactStore } from "./artifact-store";
import { ToolOutputFinalizer } from "./finalizer";

const ROOT = join(import.meta.dir, "__test_tmp__", `finalizer-${crypto.randomUUID()}`);
const artifactStore = new ToolOutputArtifactStore({ rootDir: join(ROOT, "artifacts") });
const finalizer = new ToolOutputFinalizer({
  artifactStore,
  redactionPolicy: new SecretRedactionPolicy(["runtime-secret-value"]),
});
const skillService = new SkillService({ builtinSkills: {} });

afterAll(async () => {
  await artifactStore.dispose();
  await rm(ROOT, { recursive: true, force: true });
});

function descriptor(
  outputPolicy: ToolDescriptor["outputPolicy"],
  inputSchema = z.object({}).strict(),
): ToolDescriptor {
  return {
    name: "test_tool",
    description: "test",
    inputSchema,
    outputPolicy,
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: async () => ({ isError: false, draft: { kind: "text", text: "ok" } }),
  };
}

function context() {
  const workspaceRoot = join(ROOT, "workspace");
  const store = storeManager.create(`finalizer-${crypto.randomUUID()}`, workspaceRoot, { agentName: "lead" });
  return createToolExecutionContext({
    store,
    storeManager,
    toolName: "test_tool",
    toolCallId: crypto.randomUUID(),
    input: {},
    step: 0,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["test_tool"]),
    agentSkills: [],
    skillService,
    projectContext: createTestProjectContext(workspaceRoot),
    cwd: workspaceRoot,
  });
}

describe("ToolOutputFinalizer bounds", () => {
  test("shrinks nested diff and ask presentations with explicit truncated markers", async () => {
    const files = Array.from({ length: 21 }, (_, fileIndex) => ({
      path: `${fileIndex}-${"p".repeat(5 * 1024)}`,
      hunks: [{
        header: "h".repeat(5 * 1024),
        oldStart: 1,
        oldLines: 101,
        newStart: 1,
        newLines: 101,
        lines: Array.from({ length: 101 }, () => ({ type: "add" as const, content: "x".repeat(5 * 1024) })),
      }],
    }));
    const answers = Array.from({ length: 4 }, (_, index) => ({
      question: `${index}-${"q".repeat(3 * 1024)}`,
      answers: ["a".repeat(20 * 1024), "b".repeat(20 * 1024)],
    }));
    const result = await finalizer.finalize({
      descriptor: descriptor({ kind: "inline", previewDirection: "head" }),
      raw: {
        isError: false,
        draft: { kind: "text", text: "ok" },
        details: { presentations: [{ kind: "diff", files }, { kind: "ask_user", answers }] },
      },
      context: context(),
      attempted: false,
    });

    const diff = result.details?.presentations?.[0];
    const ask = result.details?.presentations?.[1];
    expect(diff?.kind).toBe("diff");
    expect(diff && "truncated" in diff).toBe(true);
    expect(diff?.kind === "diff" ? diff.files.length : 0).toBeLessThanOrEqual(20);
    expect(ask?.kind).toBe("ask_user");
    expect(ask && "truncated" in ask).toBe(true);
    expect(ask?.kind === "ask_user" ? ask.answers.length : 0).toBeLessThanOrEqual(3);
    expect(Buffer.byteLength(JSON.stringify(result.details), "utf8")).toBeLessThanOrEqual(256 * 1024);
  });

  test("rejects source recovery that exceeds depth even when descriptor schema accepts it", async () => {
    let value: JsonValue = "end";
    for (let index = 0; index < 9; index += 1) value = { nested: value };
    const result = await finalizer.finalize({
      descriptor: descriptor(
        { kind: "source", previewDirection: "head" },
        z.object({ page: z.unknown() }).strict(),
      ),
      raw: {
        isError: false,
        draft: { kind: "source", text: "partial", nextInput: { page: value } },
      },
      context: context(),
      attempted: false,
    });

    expect(result.isError).toBe(true);
    expect(result.output.preview).toContain("TOOL_OUTPUT_POLICY_VIOLATION");
    expect(result.output.recovery.kind).toBe("none");
  });

  test("keeps every system result within the strict 50 KiB serialized budget", () => {
    const result = finalizer.finalizeSystemRaw({
      isError: true,
      draft: { kind: "text", text: `runtime-secret-value${"x".repeat(80 * 1024)}` },
      details: {
        error: { kind: "execution", code: "FAILED", name: "Error", hint: "runtime-secret-value" },
      },
    });

    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(50 * 1024);
    expect(JSON.stringify(result)).not.toContain("runtime-secret-value");
  });

  test("fits multibyte system results without synthesizing replacement characters", () => {
    const result = finalizer.finalizeSystemRaw({
      isError: false,
      draft: { kind: "text", text: `prefix-${"😀".repeat(80 * 1024)}` },
    });
    const serialized = JSON.stringify(result);

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(50 * 1024);
    expect(result.output.preview).not.toContain("�");
    expect(serialized).not.toContain("�");
  });

  test("truncates bounded fields only at valid UTF-8 boundaries", () => {
    const result = finalizer.createSystemResult({
      isError: true,
      code: `a${"😀".repeat(32)}`,
      name: `b${"😀".repeat(32)}`,
      message: "failed",
    });
    const error = result.details?.error;
    expect(Buffer.byteLength(error?.code ?? "", "utf8")).toBeLessThanOrEqual(128);
    expect(error?.code).not.toContain("�");
    expect(error?.name).not.toContain("�");
  });

  test("validates process scalars and bounds signal at runtime", async () => {
    const valid = await finalizer.finalize({
      descriptor: descriptor({ kind: "inline", previewDirection: "head" }),
      raw: {
        isError: false,
        draft: { kind: "text", text: "ok" },
        details: {
          process: {
            exitCode: 0,
            signal: `x${"😀".repeat(8)}`,
            timedOut: false,
            aborted: false,
            durationMs: 1.5,
          },
        },
      },
      context: context(),
      attempted: false,
    });
    expect(Buffer.byteLength(valid.details?.process?.signal ?? "", "utf8")).toBeLessThanOrEqual(32);
    expect(valid.details?.process?.signal).not.toContain("�");

    const invalid = await finalizer.finalize({
      descriptor: descriptor({ kind: "inline", previewDirection: "head" }),
      raw: {
        isError: false,
        draft: { kind: "text", text: "ok" },
        details: {
          process: {
            exitCode: 0,
            signal: null,
            timedOut: false,
            aborted: false,
            durationMs: Number.POSITIVE_INFINITY,
          },
        },
      },
      context: context(),
      attempted: false,
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.output.preview).toContain("TOOL_OUTPUT_POLICY_VIOLATION");
  });
});
