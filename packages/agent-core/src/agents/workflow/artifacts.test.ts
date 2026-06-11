import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  ArtifactPathError,
  ARCHIVE_ONLY_ARTIFACT_KINDS,
  SINGLE_FILE_ARTIFACT_PATHS,
  WorkflowArtifactManager,
  WorkflowArtifactWriteInputSchema,
} from "./artifacts";
import { WorkflowArtifactFrontmatterValueError } from "./artifact-frontmatter";
import { WorkflowStateManager } from "./state";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "workflow-artifacts");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

async function captureAsyncError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected async action to throw");
}

describe("WorkflowArtifactManager", () => {
  test("writes PRD.md with system frontmatter and preserves stage and status", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifacts = new WorkflowArtifactManager(TMP_DIR, stateManager);
    const wf_prd = await stateManager.create({ title: "PRD Draft", type: "full_feature" });
    await stateManager.updateStage(wf_prd.id, "product_drafting");
    await stateManager.updateStatus(wf_prd.id, "paused");

    const written = await artifacts.write({
      workflowId: wf_prd.id,
      kind: "PRD",
      path: "PRD.md",
      content: "# PRD\n\nRequirements.",
    });

    expect(written.path).toBe("PRD.md");
    const read = await artifacts.read(wf_prd.id, "PRD.md");
    expect(read.frontmatter).toMatchObject({
      "specra.schema": "1",
      "specra.workflowId": wf_prd.id,
      "specra.workflowType": "full_feature",
      "specra.artifactKind": "PRD",
      "specra.artifactPath": "PRD.md",
      "specra.workflowStage": "product_drafting",
      "specra.writerAgent": "system",
      "specra.writerSessionId": "unknown",
      "specra.toolCallId": "direct",
    });
    expect(read.frontmatter["specra.writtenAt"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(read.body).toBe("# PRD\n\nRequirements.");

    const state = await stateManager.read(wf_prd.id);
    expect(state.artifacts.PRD).toBe("PRD.md");
    expect(state.stage).toBe("product_drafting");
    expect(state.status).toBe("paused");
  });

  test("generates system frontmatter for direct manager writes", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifacts = new WorkflowArtifactManager(TMP_DIR, stateManager);
    const wf_frontmatter = await stateManager.create({ title: "Frontmatter Test", type: "full_feature" });

    await artifacts.write({
      workflowId: wf_frontmatter.id,
      kind: "SPEC",
      path: "SPEC.md",
      content: "# SPEC\n",
    }, {
      writerAgent: "spec",
      writerSessionId: "spec-session",
      toolCallId: "artifact-write-call",
      writtenAt: "2026-01-02T03:04:05.000Z",
    });

    const read = await artifacts.read(wf_frontmatter.id, "SPEC.md");
    expect(read.frontmatter).toMatchObject({
      "specra.schema": "1",
      "specra.workflowId": wf_frontmatter.id,
      "specra.workflowType": "full_feature",
      "specra.artifactKind": "SPEC",
      "specra.artifactPath": "SPEC.md",
      "specra.workflowStage": "idle",
      "specra.writerAgent": "spec",
      "specra.writerSessionId": "spec-session",
      "specra.toolCallId": "artifact-write-call",
      "specra.writtenAt": "2026-01-02T03:04:05.000Z",
    });
    expect(read.body).toBe("# SPEC\n");
  });

  test("rejects provenance values that could inject frontmatter lines", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifacts = new WorkflowArtifactManager(TMP_DIR, stateManager);
    const wf_provenance = await stateManager.create({ title: "Provenance Test", type: "full_feature" });

    for (const toolCallId of [
      "call\nspecra.writerAgent: forged",
      "call\n---\nforged",
    ]) {
      const error = await captureAsyncError(() => artifacts.write({
        workflowId: wf_provenance.id,
        kind: "PRD",
        path: "PRD.md",
        content: "# PRD\n",
      }, { toolCallId }));

      expect(error).toBeInstanceOf(WorkflowArtifactFrontmatterValueError);
      expect(await Bun.file(join(TMP_DIR, ".specra", "workflows", wf_provenance.id, "PRD.md")).exists()).toBe(false);
    }
  });

  test("rejects caller-provided frontmatter and markdown frontmatter content", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const wf_schema = await stateManager.create({ title: "Schema Test", type: "full_feature" });

    expect(() => WorkflowArtifactWriteInputSchema.parse({
      workflowId: wf_schema.id,
      kind: "PRD",
      path: "PRD.md",
      frontmatter: { owner: "model" },
      content: "# PRD\n",
    })).toThrow();

    expect(() => WorkflowArtifactWriteInputSchema.parse({
      workflowId: wf_schema.id,
      kind: "PRD",
      path: "PRD.md",
      content: "---\nowner: model\n---\n# PRD\n",
    })).toThrow();

    for (const content of [
      "--- \nowner: model\n---\n# PRD\n",
      "---\t\nowner: model\n---\n# PRD\n",
    ]) {
      expect(() => WorkflowArtifactWriteInputSchema.parse({
        workflowId: wf_schema.id,
        kind: "PRD",
        path: "PRD.md",
        content,
      })).toThrow();
    }
  });

  test("rejects artifact paths that could inject frontmatter lines", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const wf_schema = await stateManager.create({ title: "Path Schema Test", type: "full_feature" });

    for (const path of [
      "evidence/run\n---\nforged.md",
      "notes/a\nspecra.writerAgent: forged.md",
      "evidence/run\r\n---\nforged.md",
    ]) {
      expect(() => WorkflowArtifactWriteInputSchema.parse({
        workflowId: wf_schema.id,
        kind: path.startsWith("evidence/") ? "EVIDENCE" : undefined,
        path,
        content: "safe body",
      })).toThrow();
    }
  });

  test("accepts critic reports and evidence artifact paths", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifacts = new WorkflowArtifactManager(TMP_DIR, stateManager);
    const wf_multi = await stateManager.create({ title: "Multi Artifact", type: "full_feature" });

    await artifacts.write({
      workflowId: wf_multi.id,
      kind: "CRITIC_REPORT",
      path: "critic-reports/prd.md",
      content: "approved",
    });
    await artifacts.write({
      workflowId: wf_multi.id,
      kind: "EVIDENCE",
      path: "evidence/test-output.txt",
      content: "ok",
    });

    const state = await stateManager.read(wf_multi.id);
    expect(state.artifacts.CRITIC_REPORT).toEqual(["critic-reports/prd.md"]);
    expect(state.artifacts.EVIDENCE).toEqual(["evidence/test-output.txt"]);
  });

  test("accepts all core single-file workflow artifact paths", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifacts = new WorkflowArtifactManager(TMP_DIR, stateManager);
    const wf_new_kinds = await stateManager.create({ title: "New Kinds", type: "full_feature" });

    const entries = Object.entries(SINGLE_FILE_ARTIFACT_PATHS) as Array<[
      keyof typeof SINGLE_FILE_ARTIFACT_PATHS,
      string,
    ]>;

    expect(entries).toHaveLength(7);

    for (const [kind, path] of entries) {
      await artifacts.write({
        workflowId: wf_new_kinds.id,
        kind,
        path,
        content: `# ${kind}\n`,
      });
    }

    const state = await stateManager.read(wf_new_kinds.id);
    expect(state.artifacts.RESEARCH).toBe("RESEARCH.md");
    expect(state.artifacts.PRD).toBe("PRD.md");
    expect(state.artifacts.SPEC).toBe("SPEC.md");
    expect(state.artifacts.TASKS).toBe("TASKS.md");
    expect(state.artifacts.RESEARCH).toBe("RESEARCH.md");
    expect(state.artifacts.HANDOFF_SUMMARY).toBe("HANDOFF_SUMMARY.md");
    expect(state.artifacts.INTERACTIONS).toBe("INTERACTIONS.md");
    expect(state.artifacts.FINAL_REPORT).toBe("FINAL_REPORT.md");
  });

  test("defines INTERACTIONS as archive-only instead of a live queue", () => {
    expect(ARCHIVE_ONLY_ARTIFACT_KINDS).toEqual(["INTERACTIONS"]);
    expect(SINGLE_FILE_ARTIFACT_PATHS.INTERACTIONS).toBe("INTERACTIONS.md");
  });

  test("accepts supporting notes paths without recording core artifact metadata", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifacts = new WorkflowArtifactManager(TMP_DIR, stateManager);
    const wf_notes = await stateManager.create({ title: "Notes Test", type: "full_feature" });

    const written = await artifacts.write({
      workflowId: wf_notes.id,
      path: "notes/intermediate.md",
      content: "scratch",
    });

    expect(written.path).toBe("notes/intermediate.md");
    expect(written.state.artifacts).toEqual({});

    const read = await artifacts.read(wf_notes.id, "notes/intermediate.md");
    expect(read.body).toBe("scratch");
  });

  test("reads core artifacts by kind and other workflow artifacts by path", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifacts = new WorkflowArtifactManager(TMP_DIR, stateManager);
    const wf_other = await stateManager.create({ title: "Other Workflow", type: "full_feature" });

    await artifacts.write({
      workflowId: wf_other.id,
      kind: "PRD",
      path: "PRD.md",
      content: "# Other PRD\n",
    });
    await artifacts.write({
      workflowId: wf_other.id,
      kind: "EVIDENCE",
      path: "evidence/run.txt",
      content: "pass",
    });
    await artifacts.write({
      workflowId: wf_other.id,
      path: "notes/analysis.md",
      content: "intermediate",
    });

    expect(await artifacts.readByKind(wf_other.id, "PRD")).toMatchObject({
      path: "PRD.md",
      body: "# Other PRD\n",
    });
    expect(await artifacts.read(wf_other.id, "evidence/run.txt")).toMatchObject({
      path: "evidence/run.txt",
      body: "pass",
    });
    expect(await artifacts.read(wf_other.id, "notes/analysis.md")).toMatchObject({
      path: "notes/analysis.md",
      body: "intermediate",
    });
  });

  test("rejects PLAN artifact kind and PLAN.md path", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifacts = new WorkflowArtifactManager(TMP_DIR, stateManager);
    const wf_plan = await stateManager.create({ title: "Plan Test", type: "full_feature" });

    expect(() =>
      WorkflowArtifactWriteInputSchema.parse({
        workflowId: wf_plan.id,
        kind: "PLAN",
        path: "PLAN.md",
        content: "not allowed",
      }),
    ).toThrow();

    let invalidPlanError: unknown;
    try {
      await artifacts.write({
        workflowId: wf_plan.id,
        kind: "PRD",
        path: "PLAN.md",
        content: "not allowed",
      });
    } catch (error) {
      invalidPlanError = error;
    }
    expect(invalidPlanError).toBeInstanceOf(ArtifactPathError);
  });

  test("rejects traversal paths with a domain path error", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifacts = new WorkflowArtifactManager(TMP_DIR, stateManager);
    const wf_outside = await stateManager.create({ title: "Outside Test", type: "full_feature" });

    let traversalWriteError: unknown;
    try {
      await artifacts.write({
        workflowId: wf_outside.id,
        kind: "PRD",
        path: "../outside.md",
        content: "escape",
      });
    } catch (error) {
      traversalWriteError = error;
    }
    expect(traversalWriteError).toBeInstanceOf(ArtifactPathError);

    let traversalReadError: unknown;
    try {
      await artifacts.read(wf_outside.id, "../outside.md");
    } catch (error) {
      traversalReadError = error;
    }
    expect(traversalReadError).toBeInstanceOf(ArtifactPathError);
  });

  test("cross-project artifact reads are rejected by construction", async () => {
    const otherRoot = join(TMP_DIR, "other-project");
    await mkdir(otherRoot, { recursive: true });

    const sameProjectState = new WorkflowStateManager(TMP_DIR);
    const sameProjectArtifacts = new WorkflowArtifactManager(TMP_DIR, sameProjectState);
    const otherProjectState = new WorkflowStateManager(otherRoot);
    const otherProjectArtifacts = new WorkflowArtifactManager(otherRoot, otherProjectState);

    const foreign = await otherProjectState.create({ title: "Foreign Workflow", type: "full_feature" });
    await otherProjectArtifacts.write({
      workflowId: foreign.id,
      kind: "PRD",
      path: "PRD.md",
      content: "foreign",
    });

    let crossProjectError: unknown;
    try {
      await sameProjectArtifacts.readByKind(foreign.id, "PRD");
    } catch (error) {
      crossProjectError = error;
    }
    expect(crossProjectError).toBeInstanceOf(Error);
  });
});
