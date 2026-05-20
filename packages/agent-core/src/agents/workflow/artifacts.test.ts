import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  ArtifactPathError,
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
    await stateManager.create({ id: "wf-prd" });
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
    await stateManager.create({ id: "wf-frontmatter" });

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
    await stateManager.create({ id: "wf-multi" });

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
    await stateManager.create({ id: "wf-plan" });

    await expect(
      artifacts.write({
        workflowId: "wf-plan",
        kind: "PRD",
        path: "PLAN.md",
        content: "not allowed",
      }),
    ).rejects.toThrow(ArtifactPathError);
  });

  test("rejects traversal paths with a domain path error", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifacts = new WorkflowArtifactManager(TMP_DIR, stateManager);
    await stateManager.create({ id: "wf-outside" });

    await expect(
      artifacts.write({
        workflowId: "wf-outside",
        kind: "PRD",
        path: "../outside.md",
        content: "escape",
      }),
    ).rejects.toThrow(ArtifactPathError);
  });
});
