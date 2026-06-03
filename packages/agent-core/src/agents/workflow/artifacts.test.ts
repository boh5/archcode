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
    await stateManager.create({ id: "wf-prd", type: "full_feature" });
    await stateManager.updateStage("wf-prd", "product_drafting");
    await stateManager.updateStatus("wf-prd", "paused");

    const written = await artifacts.write({
      workflowId: "wf-prd",
      kind: "PRD",
      path: "PRD.md",
      frontmatter: { owner: "product", version: "1" },
      content: "# PRD\n\nRequirements.",
    });

    expect(written.path).toBe("PRD.md");
    expect(await Bun.file(join(TMP_DIR, ".specra", "workflows", "wf-prd", "PRD.md")).text()).toBe(
      "---\nowner: product\nversion: 1\n---\n# PRD\n\nRequirements.",
    );

    const state = await stateManager.read("wf-prd");
    expect(state.artifacts.PRD).toBe("PRD.md");
    expect(state.stage).toBe("product_drafting");
    expect(state.status).toBe("paused");
  });

  test("round-trips frontmatter using shared helpers", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifacts = new WorkflowArtifactManager(TMP_DIR, stateManager);
    await stateManager.create({ id: "wf-frontmatter", type: "full_feature" });

    await artifacts.write({
      workflowId: "wf-frontmatter",
      kind: "SPEC",
      path: "SPEC.md",
      frontmatter: { owner: "architect", status: "draft" },
      content: "# SPEC\n",
    });

    const read = await artifacts.read("wf-frontmatter", "SPEC.md");
    expect(read.frontmatter).toEqual({ owner: "architect", status: "draft" });
    expect(read.body).toBe("# SPEC\n");
  });

  test("accepts critic reports and evidence artifact paths", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifacts = new WorkflowArtifactManager(TMP_DIR, stateManager);
    await stateManager.create({ id: "wf-multi", type: "full_feature" });

    await artifacts.write({
      workflowId: "wf-multi",
      kind: "CRITIC_REPORT",
      path: "critic-reports/prd.md",
      frontmatter: { reviewer: "critic" },
      content: "approved",
    });
    await artifacts.write({
      workflowId: "wf-multi",
      kind: "EVIDENCE",
      path: "evidence/test-output.txt",
      content: "ok",
    });

    const state = await stateManager.read("wf-multi");
    expect(state.artifacts.CRITIC_REPORT).toEqual(["critic-reports/prd.md"]);
    expect(state.artifacts.EVIDENCE).toEqual(["evidence/test-output.txt"]);
  });

  test("accepts all core single-file workflow artifact paths", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifacts = new WorkflowArtifactManager(TMP_DIR, stateManager);
    await stateManager.create({ id: "wf-new-kinds", type: "full_feature" });

    const entries = Object.entries(SINGLE_FILE_ARTIFACT_PATHS) as Array<[
      keyof typeof SINGLE_FILE_ARTIFACT_PATHS,
      string,
    ]>;

    expect(entries).toHaveLength(7);

    for (const [kind, path] of entries) {
      await artifacts.write({
        workflowId: "wf-new-kinds",
        kind,
        path,
        content: `# ${kind}\n`,
      });
    }

    const state = await stateManager.read("wf-new-kinds");
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
    await stateManager.create({ id: "wf-notes", type: "full_feature" });

    const written = await artifacts.write({
      workflowId: "wf-notes",
      path: "notes/intermediate.md",
      content: "scratch",
    });

    expect(written.path).toBe("notes/intermediate.md");
    expect(written.state.artifacts).toEqual({});

    const read = await artifacts.read("wf-notes", "notes/intermediate.md");
    expect(read.body).toBe("scratch");
  });

  test("reads core artifacts by kind and other workflow artifacts by path", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifacts = new WorkflowArtifactManager(TMP_DIR, stateManager);
    await stateManager.create({ id: "wf-current", type: "full_feature" });
    await stateManager.create({ id: "wf-other", type: "full_feature" });

    await artifacts.write({
      workflowId: "wf-other",
      kind: "PRD",
      path: "PRD.md",
      frontmatter: { kind: "PRD" },
      content: "# Other PRD\n",
    });
    await artifacts.write({
      workflowId: "wf-other",
      kind: "EVIDENCE",
      path: "evidence/run.txt",
      content: "pass",
    });
    await artifacts.write({
      workflowId: "wf-other",
      path: "notes/analysis.md",
      content: "intermediate",
    });

    expect(await artifacts.readByKind("wf-other", "PRD")).toMatchObject({
      path: "PRD.md",
      body: "# Other PRD\n",
    });
    expect(await artifacts.read("wf-other", "evidence/run.txt")).toMatchObject({
      path: "evidence/run.txt",
      body: "pass",
    });
    expect(await artifacts.read("wf-other", "notes/analysis.md")).toMatchObject({
      path: "notes/analysis.md",
      body: "intermediate",
    });
  });

  test("rejects PLAN artifact kind and PLAN.md path", async () => {
    expect(() =>
      WorkflowArtifactWriteInputSchema.parse({
        workflowId: "wf-plan",
        kind: "PLAN",
        path: "PLAN.md",
        content: "not allowed",
      }),
    ).toThrow();

    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifacts = new WorkflowArtifactManager(TMP_DIR, stateManager);
    await stateManager.create({ id: "wf-plan", type: "full_feature" });

    let invalidPlanError: unknown;
    try {
      await artifacts.write({
        workflowId: "wf-plan",
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
    await stateManager.create({ id: "wf-outside", type: "full_feature" });

    let traversalWriteError: unknown;
    try {
      await artifacts.write({
        workflowId: "wf-outside",
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
      await artifacts.read("wf-outside", "../outside.md");
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

    await otherProjectState.create({ id: "wf-foreign", type: "full_feature" });
    await otherProjectArtifacts.write({
      workflowId: "wf-foreign",
      kind: "PRD",
      path: "PRD.md",
      content: "foreign",
    });

    let crossProjectError: unknown;
    try {
      await sameProjectArtifacts.readByKind("wf-foreign", "PRD");
    } catch (error) {
      crossProjectError = error;
    }
    expect(crossProjectError).toBeInstanceOf(Error);
  });
});
