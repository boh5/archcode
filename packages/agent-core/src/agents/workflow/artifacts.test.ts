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
import { WorkflowStateManager } from "./state";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "workflow-artifacts");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("WorkflowArtifactManager", () => {
  test("writes PRD.md, records metadata, and preserves stage and status", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifacts = new WorkflowArtifactManager(TMP_DIR, stateManager);
    const wf_prd = await stateManager.create({ title: "PRD Draft", type: "full_feature" });
    await stateManager.updateStage(wf_prd.id, "product_drafting");
    await stateManager.updateStatus(wf_prd.id, "paused");

    const written = await artifacts.write({
      workflowId: wf_prd.id,
      kind: "PRD",
      path: "PRD.md",
      frontmatter: { owner: "product", version: "1" },
      content: "# PRD\n\nRequirements.",
    });

    expect(written.path).toBe("PRD.md");
    expect(await Bun.file(join(TMP_DIR, ".specra", "workflows", wf_prd.id, "PRD.md")).text()).toBe(
      "---\nowner: product\nversion: 1\n---\n# PRD\n\nRequirements.",
    );

    const state = await stateManager.read(wf_prd.id);
    expect(state.artifacts.PRD).toBe("PRD.md");
    expect(state.stage).toBe("product_drafting");
    expect(state.status).toBe("paused");
  });

  test("round-trips frontmatter using shared helpers", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifacts = new WorkflowArtifactManager(TMP_DIR, stateManager);
    const wf_frontmatter = await stateManager.create({ title: "Frontmatter Test", type: "full_feature" });

    await artifacts.write({
      workflowId: wf_frontmatter.id,
      kind: "SPEC",
      path: "SPEC.md",
      frontmatter: { owner: "architect", status: "draft" },
      content: "# SPEC\n",
    });

    const read = await artifacts.read(wf_frontmatter.id, "SPEC.md");
    expect(read.frontmatter).toEqual({ owner: "architect", status: "draft" });
    expect(read.body).toBe("# SPEC\n");
  });

  test("accepts critic reports and evidence artifact paths", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifacts = new WorkflowArtifactManager(TMP_DIR, stateManager);
    const wf_multi = await stateManager.create({ title: "Multi Artifact", type: "full_feature" });

    await artifacts.write({
      workflowId: wf_multi.id,
      kind: "CRITIC_REPORT",
      path: "critic-reports/prd.md",
      frontmatter: { reviewer: "critic" },
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
      frontmatter: { kind: "PRD" },
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
