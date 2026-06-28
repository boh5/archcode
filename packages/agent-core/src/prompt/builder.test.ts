import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "./builder";
import type { PromptContext } from "./types";

function makeCtx(overrides?: Partial<PromptContext>): PromptContext {
  return {
    allowedTools: ["file_read", "file_write"],
    workspaceRoot: "/home/user/project",
    promptProfileId: "default",
    env: {
      platform: "darwin",
      timezone: "America/Los_Angeles",
      locale: "en-US",
      cwd: "/home/user/project",
      date: "2025-01-15",
    },
    ...overrides,
  };
}

describe("buildSystemPrompt", () => {
  test("includes identity section", async () => {
    const result = await buildSystemPrompt(makeCtx());
    expect(result).toContain("ArchCode");
    expect(result).toContain("default");
  });

  test("includes guidelines section", async () => {
    const result = await buildSystemPrompt(makeCtx());
    expect(result).toContain("## Guidelines");
  });

  test("includes tools section", async () => {
    const result = await buildSystemPrompt(makeCtx());
    expect(result).toContain("## Tools");
    expect(result).toContain("file_read");
    expect(result).toContain("file_write");
  });

  test("includes workflow MVP instructions for orchestrator workflow tools", async () => {
    const result = await buildSystemPrompt(makeCtx({
      allowedTools: [
        "ask_user",
        "workflow_create",
        "workflow_update_stage",
        "workflow_complete",
        "workflow_record_completion",
        "workflow_propose_interactions",
        "workflow_request_interactions",
        "artifact_read",
        "artifact_write",
      ],
    }));

    expect(result).toContain("## Workflow MVP Orchestration");
    expect(result).toContain("research_only");
    expect(result).toContain("quick_fix");
    expect(result).toContain("full_feature");
    expect(result).toContain("idle -> product_drafting");
    expect(result).toContain("Use workflow_update_stage for every business-stage move");
    expect(result).toContain("record the current stage as completed with workflow_record_completion");
    expect(result).toContain("Use workflow_complete");
    expect(result).toContain("Use artifact_write for durable workflow artifacts");
    expect(result).toContain("Use artifact_read before relying on prior artifacts");
    expect(result).toContain("derived full_feature workflow");
  });

  test("includes batched workflow interaction clearance instructions for orchestrator gates", async () => {
    const result = await buildSystemPrompt(makeCtx({
      allowedTools: [
        "ask_user",
        "workflow_create",
        "workflow_read",
        "workflow_update_stage",
        "workflow_record_completion",
        "workflow_propose_interactions",
        "workflow_request_interactions",
        "artifact_read",
      ],
    }));

    expect(result).toContain("### Delegate → Propose → Ask → Resume loop");
    expect(result).toContain("There is no separate requirements-gate stage");
    expect(result).toContain("delegate(session_id=...)");
    expect(result).toContain("workflow_propose_interactions");
    expect(result).toContain("workflow_request_interactions");
    expect(result).toContain("calls workflow_request_interactions once per batch");
    expect(result).toContain("resumes the sub-agent with answers using delegate(session_id=...)");
    expect(result).toContain("Do not advance while workflow_read reports unresolved interactions");
    expect(result).toContain("Sub-agents proactively research and may propose questions during their execution using workflow_propose_interactions");
    expect(result).toContain("Do not ask one question at a time when multiple proposals exist for the same gate");
  });

  test("keeps role instructions before workflow intent gate for orchestrator prompts", async () => {
    const result = await buildSystemPrompt(makeCtx({
      rolePrompt: "## Workflow Role: Orchestrator\nRole ordering sentinel.",
      allowedTools: ["ask_user", "workflow_create", "workflow_read", "artifact_read"],
    }));

    const roleIdx = result.indexOf("## Workflow Role: Orchestrator");
    const gateIdx = result.indexOf("## Workflow MVP Orchestration");

    expect(roleIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(roleIdx).toBeLessThan(gateIdx);
  });

  test("Active Workflow section includes exact workflow details and UUID rules for workflow-capable tools", async () => {
    const workflowId = "550e8400-e29b-41d4-a716-446655440000";
    const workflowTitle = "Implement UUID workflow context";
    const result = await buildSystemPrompt(makeCtx({
      allowedTools: ["ask_user", "workflow_create", "workflow_read", "artifact_read"],
      activeWorkflow: {
        id: workflowId,
        title: workflowTitle,
        type: "full_feature",
        stage: "foreman_executing",
        status: "active",
      },
    }));

    expect(result).toContain("## Active Workflow");
    expect(result).toContain(`Workflow ID: ${workflowId}`);
    expect(result).toContain(`Title: ${workflowTitle}`);
    expect(result).toContain("Type: full_feature");
    expect(result).toContain("Stage: foreman_executing");
    expect(result).toContain("Status: active");
    expect(result).toContain(`Use the exact workflow UUID \`${workflowId}\``);
    expect(result).toContain("all workflow and artifact tool calls");
    expect(result).toContain("Never invent workflow IDs");
    expect(result).toContain("Never use `default`, a slug, or a title as a workflow ID");
    expect(result).toContain(workflowTitle);
    expect(result).toContain("Use any other workflow UUID only when an explicit read reference provides that UUID");

    const gateIdx = result.indexOf("## Workflow MVP Orchestration");
    const activeIdx = result.indexOf("## Active Workflow");
    const toolsIdx = result.indexOf("## Tools");
    expect(activeIdx).toBeGreaterThan(gateIdx);
    expect(activeIdx).toBeLessThan(toolsIdx);
  });

  test("Active Workflow section injects resolved decisions as downstream execution constraints", async () => {
    const result = await buildSystemPrompt(makeCtx({
      allowedTools: ["workflow_read", "artifact_read", "artifact_write"],
      activeWorkflow: {
        id: "550e8400-e29b-41d4-a716-446655440000",
        title: "Constrained workflow",
        type: "full_feature",
        stage: "foreman_executing",
        status: "active",
        resolvedInteractions: [{
          id: "interaction-1",
          decisionKey: "requirements.scope",
          stage: "product_drafting",
          sourceAgent: "product",
          kind: "decision",
          question: "Should billing be included?",
          options: ["Include billing", "Exclude billing"],
          rationale: "Defines implementation scope.",
          status: "resolved",
          answer: "Include billing",
          resolvedAt: "2026-06-23T10:05:00.000Z",
          revision: 1,
        }],
      },
    }));

    expect(result).toContain("### Resolved Workflow Decisions — Execution Constraints");
    expect(result).toContain("Critic, Foreman, Builder, and Reviewer roles must treat these terminal decisions as binding constraints");
    expect(result).toContain("requirements.scope");
    expect(result).toContain("Stage: product_drafting");
    expect(result).toContain("Source: product");
    expect(result).toContain("Answer: Include billing");
    expect(result).toContain("Question: Should billing be included?");
  });

  test("Active Workflow section is omitted when no active workflow exists", async () => {
    const result = await buildSystemPrompt(makeCtx({ allowedTools: ["workflow_read", "artifact_read"] }));

    expect(result).not.toContain("## Active Workflow");
  });

  test("Active Workflow section is omitted when tools are not workflow-capable", async () => {
    const result = await buildSystemPrompt(makeCtx({
      allowedTools: ["file_read", "grep"],
      activeWorkflow: {
        id: "550e8400-e29b-41d4-a716-446655440001",
        title: "Hidden workflow",
        type: "research_only",
        stage: "researching",
        status: "active",
      },
    }));

    expect(result).not.toContain("## Active Workflow");
    expect(result).not.toContain("Hidden workflow");
  });

  test("includes environment section", async () => {
    const result = await buildSystemPrompt(makeCtx());
    expect(result).toContain("## Environment");
    expect(result).toContain("Platform: darwin");
  });

  test("omits project context when agentsMd is undefined", async () => {
    const result = await buildSystemPrompt(makeCtx({ agentsMd: undefined }));
    expect(result).not.toContain("## Project Context");
  });

  test("includes project context when agentsMd is provided", async () => {
    const agentsMd = "# My Project\nSome instructions.";
    const result = await buildSystemPrompt(makeCtx({ agentsMd }));
    expect(result).toContain("## Project Context");
    expect(result).toContain("My Project");
  });

  test("includes project context when agentsMd is empty string", async () => {
    const result = await buildSystemPrompt(makeCtx({ agentsMd: "" }));
    expect(result).toContain("## Project Context");
  });

  test("sections appear in correct order with skills section between guidelines and tools", async () => {
    const result = await buildSystemPrompt(makeCtx({
      promptProfileId: "builder",
      rolePrompt: "## Workflow Role: Builder\nTest content.",
      agentsMd: "AGENTSCONTENT",
      availableSkills: [{ name: "git-master", description: "Git expertise", when_to_use: "Use for git ops.", source: "builtin" }],
    }));
    const identityIdx = result.indexOf("ArchCode");
    const roleIdx = result.indexOf("## Workflow Role: Builder");
    const guidelinesIdx = result.indexOf("## Guidelines");
    const skillsIdx = result.indexOf("## Skills");
    const toolsIdx = result.indexOf("## Tools");
    const envIdx = result.indexOf("## Environment");
    const projectIdx = result.indexOf("## Project Context");

    expect(identityIdx).toBeLessThan(roleIdx);
    expect(roleIdx).toBeLessThan(guidelinesIdx);
    expect(guidelinesIdx).toBeLessThan(skillsIdx);
    expect(skillsIdx).toBeLessThan(toolsIdx);
    expect(toolsIdx).toBeLessThan(envIdx);
    expect(envIdx).toBeLessThan(projectIdx);
  });

  test("skills section is omitted when no available or active skills", async () => {
    const result = await buildSystemPrompt(makeCtx());
    expect(result).not.toContain("## Skills");
    expect(result).not.toContain("<available-skills>");
    expect(result).not.toContain("<active-skills>");
  });
});

describe("workflow prompt deduplication", () => {
  const workflowTools = [
    "ask_user",
    "workflow_create",
    "workflow_read",
    "workflow_update_stage",
    "workflow_complete",
    "workflow_record_completion",
    "workflow_propose_interactions",
    "workflow_request_interactions",
    "artifact_read",
    "artifact_write",
  ];

  const orchestratorRolePrompt = `## Workflow Role: Orchestrator

You own workflow state, stage transitions, delegation sequencing, user approval gates, and final reporting.

Explicit workflow stage flow:
1. Create workflow state with workflow_create and the correct workflow type before delegating workflow roles.
2. research_only: move idle -> researching -> research_consolidation, delegate/read research, record verified stage completion, then use workflow_complete only after the research output is durable.
3. quick_fix: move idle -> quick_analysis -> quick_patch -> quick_verify for narrow low-risk fixes; keep scope small and verify before completion.
4. full_feature PRD loop: move idle -> product_drafting, delegate Product to write the PRD artifact only, clear unresolved interactions, read PRD with artifact_read, record product_drafting completion, move to critic_prd_review, then delegate Critic.
5. Treat Critic outcomes as Orchestrator decisions, not tool parameters. If Critic approves the PRD, read the report, record the review stage completion, and move to spec_drafting. If Critic requests changes, read the report, move back to product_drafting, and re-delegate Product with the report. If Critic rejects or retry limits block progress, pause or fail the workflow with a clear lastError/status using the available workflow tools and report the decision.
6. full_feature SPEC loop: after PRD approval, delegate Spec to write SPEC and TASKS artifacts only, clear unresolved interactions, read SPEC/TASKS with artifact_read, record spec_drafting completion, move to critic_spec_review, then delegate Critic.
7. If Critic approves SPEC/TASKS, read the report, clear unresolved interactions, record critic_spec_review completion, and move to awaiting_user_approval. If Critic requests changes, move back to spec_drafting and re-delegate Spec with the report. If Critic rejects or retry limits block progress, pause or fail with a clear status/lastError and report the decision.
8. After SPEC/TASKS quality approval, call ask_user for explicit execution approval before Foreman.
9. Only if the user explicitly approves, update the workflow with that approval, move to foreman_executing, and delegate Foreman.
10. After Foreman completes, read artifacts/reports, record completion of foreman_executing with workflow_record_completion, move to final_review, perform final verification/reporting, ensure the final report exists, record completion of final_review, then use workflow_complete.

Delegate→propose→ask→resume interaction loop:
- Orchestrator owns the user-facing workflow decision loop: delegate Product/Spec/Critic → the sub-agent researches and may propose interactions via workflow_propose_interactions → Orchestrator collects proposals → Orchestrator calls workflow_request_interactions to ask the user → Orchestrator resumes the sub-agent with answers using delegate(session_id=...) → repeat until no unresolved interactions remain → advance to the next stage.
- Product, Spec, and Critic must propose questions with workflow_propose_interactions. Do not use ask_user for Product/Spec/Critic planning questions.
- Only Orchestrator uses workflow_request_interactions to ask the user for batched gate decisions.
- Collect all proposals for the current gate, dedupe/merge related interactions, then call workflow_request_interactions once per gate; batch same-gate decisions instead of serially interrupting the user.
- Apply the same loop before PRD review, before SPEC review, and before accepting Critic approval.
- After workflow_request_interactions resolves, use workflow_read as the source of truth. Persisted resolvedInteractions clear answered interactions; unresolved requiredInteractions still prevent progression.
- When resuming a sub-agent, pass the session_id returned from the original delegate call. The sub-agent retains its full history.
- Do not rely solely on free-form artifact text parsing for required decisions; workflow state is canonical.

Critical gates:
- Critic approval is a quality gate only, NOT user approval.
- Never delegate Foreman automatically from Critic approval.
- Never skip ask_user before Foreman.
- If the user rejects or withholds execution approval, do not enter foreman_executing; record a failed or paused workflow status/lastError using the available workflow tools and report the decision.

Stage transition rules:
- You MUST use workflow_record_completion before advancing from any non-idle stage. The transition guard rejects forward moves from stages with no completion record.
- Use ordinary workflow_update_stage transitions for Critic-approved, change-requested, or rejected outcomes; the outcome is your decision after reading the Critic report.
- Never advance out of a stage while workflow_read shows unresolved interactions for that stage.
- CRITIC_REPORT and EVIDENCE are multi-file artifacts. To read them, pass their kind to artifact_read to list real paths, then read a specific entry by its returned path.

Delegation boundaries:
- Product and Spec stages produce artifacts only; do not ask them to edit implementation source files.
- You control workflow state, delegation, user gates, and reporting only. Never write workflow artifacts yourself.
- Do not call artifact_write for PRD, SPEC, TASKS, critic reports, evidence, or final workflow artifacts. If an artifact is missing or invalid, re-delegate the responsible workflow role instead of attempting repair.
- Use Librarian for focused read-only retrieval of codebase context, prior artifacts, or documentation.
- Read artifacts and critic reports before deciding each transition.
- Use workflow_task_check only for verified TASKS.md execution state when coordinating with Foreman output.
- Use cancel_session(session_id=...) to interrupt a running sub-agent if the direction is wrong or it's taking too long.

LLM Intent Gate for workflow derivation:
- Before broadening scope, verbalize the upgrade judgment: explain why the current workflow type is insufficient and which target type fits (for example research_only -> full_feature when implementation/spec execution is now required, or quick_fix -> full_feature when product/spec/critic gates are needed).
- Ask the user for explicit confirmation before creating a derived workflow. Never silently upgrade, never mutate the source workflow type, and never reuse the source orchestrator session for the derived workflow.
- When a derived workflow starts from a handoff, child agents must call artifact_read for referenced source artifacts instead of relying only on summarized text.
- Batch related interactions and unknowns before asking the user; avoid serial one-question interruptions when the decisions are part of the same upgrade gate.`;

  test("critical gates are present: user approval before Foreman, workflow_request_interactions, artifact_read, interaction batching", async () => {
    const result = await buildSystemPrompt(makeCtx({
      rolePrompt: orchestratorRolePrompt,
      allowedTools: workflowTools,
    }));

    expect(result).toContain("ask_user for explicit execution approval before Foreman");
    expect(result).toContain("workflow_request_interactions");
    expect(result).toContain("artifact_read");
    expect(result).toContain("Do not ask one question at a time when multiple proposals exist for the same gate");
  });

  test("workflow_record_completion before advancing appears exactly once (not duplicated from orchestrator.ts and workflow-intent-gate.ts)", async () => {
    const result = await buildSystemPrompt(makeCtx({
      rolePrompt: orchestratorRolePrompt,
      allowedTools: workflowTools,
    }));

    const matches = result.match(/workflow_record_completion before advancing/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  test("legacy critic outcome parameter instructions are absent from workflow prompts", async () => {
    const result = await buildSystemPrompt(makeCtx({
      rolePrompt: orchestratorRolePrompt,
      allowedTools: workflowTools,
    }));

    const legacyCriticOutcomeParam = "critic" + "Decision";
    const matches = result.match(new RegExp(`${legacyCriticOutcomeParam} parameter`, "g"));
    expect(matches).toBeNull();
    expect(result).not.toContain(legacyCriticOutcomeParam);
  });

  test("'do not ask one question at a time' appears exactly once (not duplicated)", async () => {
    const result = await buildSystemPrompt(makeCtx({
      rolePrompt: orchestratorRolePrompt,
      allowedTools: workflowTools,
    }));

    const matches = result.match(/do not ask one question at a time when multiple proposals/gim);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  test("prompt length is reasonable — no full stage-flow block duplication inflates prompt size", async () => {
    const result = await buildSystemPrompt(makeCtx({
      rolePrompt: orchestratorRolePrompt,
      allowedTools: workflowTools,
    }));

    // The prompt should be under 12000 chars. Current duplication inflates it beyond this.
    // After deduplication (T9), it should fit comfortably under this threshold.
    expect(result.length).toBeLessThan(12000);
  });
});

describe("clean-break critic prompt contract", () => {
  // These tests define the new contract AFTER T10 removes the legacy Critic
  // outcome parameter from
  // workflow_update_stage's schema. The Orchestrator must describe Critic
  // outcomes as Orchestrator decisions, not tool parameters.
  //
  // Tests FAIL against current code (red phase) because:
  //   1. The prompt still mentions the legacy Critic outcome field as valid
  //   2. Critic outcomes are described as tool parameters, not Orchestrator decisions
  //
  // After T10:
  //   - the legacy Critic outcome field is removed from the orchestrator prompt
  //   - Critic outcomes (approved/rejected) are described as Orchestrator decisions
  //     using generic terminal lifecycle: workflow_update_stage with status: "failed"/"paused"

  const legacyCriticOutcomeParam = "critic" + "Decision";

  const criticContractWorkflowTools = [
    "ask_user",
    "workflow_create",
    "workflow_read",
    "workflow_update_stage",
    "workflow_complete",
    "workflow_record_completion",
    "workflow_propose_interactions",
    "workflow_request_interactions",
    "artifact_read",
    "artifact_write",
  ];

  const criticContractRolePrompt = `## Workflow Role: Orchestrator

You own workflow state, stage transitions, delegation sequencing, user approval gates, and final reporting.

Explicit workflow stage flow:
1. Create workflow state with workflow_create and the correct workflow type before delegating workflow roles.
2. research_only: move idle -> researching -> research_consolidation, delegate/read research, record verified stage completion, then use workflow_complete only after the research output is durable.
3. quick_fix: move idle -> quick_analysis -> quick_patch -> quick_verify for narrow low-risk fixes; keep scope small and verify before completion.
4. full_feature PRD loop: move idle -> product_drafting, delegate Product to write the PRD artifact only, clear unresolved interactions, read PRD with artifact_read, record product_drafting completion, move to critic_prd_review, then delegate Critic.
5. Treat Critic outcomes as Orchestrator decisions, not tool parameters. If Critic approves the PRD, read the report, record the review stage completion, and move to spec_drafting. If Critic requests changes, read the report, move back to product_drafting, and re-delegate Product with the report. If Critic rejects or retry limits block progress, pause or fail the workflow with a clear lastError/status using the available workflow tools and report the decision.
6. full_feature SPEC loop: after PRD approval, delegate Spec to write SPEC and TASKS artifacts only, clear unresolved interactions, read SPEC/TASKS with artifact_read, record spec_drafting completion, move to critic_spec_review, then delegate Critic.
7. If Critic approves SPEC/TASKS, read the report, clear unresolved interactions, record critic_spec_review completion, and move to awaiting_user_approval. If Critic requests changes, move back to spec_drafting and re-delegate Spec with the report. If Critic rejects or retry limits block progress, pause or fail with a clear status/lastError and report the decision.
8. After SPEC/TASKS quality approval, call ask_user for explicit execution approval before Foreman.
9. Only if the user explicitly approves, update the workflow with that approval, move to foreman_executing, and delegate Foreman.
10. After Foreman completes, read artifacts/reports, record completion of foreman_executing with workflow_record_completion, move to final_review, perform final verification/reporting, ensure the final report exists, record completion of final_review, then use workflow_complete.

Delegate→propose→ask→resume interaction loop:
- Orchestrator owns the user-facing workflow decision loop: delegate Product/Spec/Critic → the sub-agent researches and may propose interactions via workflow_propose_interactions → Orchestrator collects proposals → Orchestrator calls workflow_request_interactions to ask the user → Orchestrator resumes the sub-agent with answers using delegate(session_id=...) → repeat until no unresolved interactions remain → advance to the next stage.
- Product, Spec, and Critic must propose questions with workflow_propose_interactions. Do not use ask_user for Product/Spec/Critic planning questions.
- Only Orchestrator uses workflow_request_interactions to ask the user for batched gate decisions.
- Collect all proposals for the current gate, dedupe/merge related interactions, then call workflow_request_interactions once per gate; batch same-gate decisions instead of serially interrupting the user.
- Apply the same loop before PRD review, before SPEC review, and before accepting Critic approval.
- After workflow_request_interactions resolves, use workflow_read as the source of truth. Persisted resolvedInteractions clear answered interactions; unresolved requiredInteractions still prevent progression.
- When resuming a sub-agent, pass the session_id returned from the original delegate call. The sub-agent retains its full history.
- Do not rely solely on free-form artifact text parsing for required decisions; workflow state is canonical.

Critical gates:
- Critic approval is a quality gate only, NOT user approval.
- Never delegate Foreman automatically from Critic approval.
- Never skip ask_user before Foreman.
- If the user rejects or withholds execution approval, do not enter foreman_executing; record a failed or paused workflow status/lastError using the available workflow tools and report the decision.

Stage transition rules:
- You MUST use workflow_record_completion before advancing from any non-idle stage. The transition guard rejects forward moves from stages with no completion record.
- Use ordinary workflow_update_stage transitions for Critic-approved, change-requested, or rejected outcomes; the outcome is your decision after reading the Critic report.
- Never advance out of a stage while workflow_read shows unresolved interactions for that stage.
- CRITIC_REPORT and EVIDENCE are multi-file artifacts. To read them, pass their kind to artifact_read to list real paths, then read a specific entry by its returned path.

Delegation boundaries:
- Product and Spec stages produce artifacts only; do not ask them to edit implementation source files.
- You control workflow state, delegation, user gates, and reporting only. Never write workflow artifacts yourself.
- Do not call artifact_write for PRD, SPEC, TASKS, critic reports, evidence, or final workflow artifacts. If an artifact is missing or invalid, re-delegate the responsible workflow role instead of attempting repair.
- Use Librarian for focused read-only retrieval of codebase context, prior artifacts, or documentation.
- Read artifacts and critic reports before deciding each transition.
- Use workflow_task_check only for verified TASKS.md execution state when coordinating with Foreman output.
- Use cancel_session(session_id=...) to interrupt a running sub-agent if the direction is wrong or it's taking too long.

LLM Intent Gate for workflow derivation:
- Before broadening scope, verbalize the upgrade judgment: explain why the current workflow type is insufficient and which target type fits (for example research_only -> full_feature when implementation/spec execution is now required, or quick_fix -> full_feature when product/spec/critic gates are needed).
- Ask the user for explicit confirmation before creating a derived workflow. Never silently upgrade, never mutate the source workflow type, and never reuse the source orchestrator session for the derived workflow.
- When a derived workflow starts from a handoff, child agents must call artifact_read for referenced source artifacts instead of relying only on summarized text.
- Batch related interactions and unknowns before asking the user; avoid serial one-question interruptions when the decisions are part of the same upgrade gate.`;

  test("Orchestrator prompt does NOT mention the legacy Critic outcome field as a valid parameter", async () => {
    const result = await buildSystemPrompt(makeCtx({
      rolePrompt: criticContractRolePrompt,
      allowedTools: criticContractWorkflowTools,
    }));

    // Red phase: this FAILS while the prompt describes Critic outcomes as a
    // workflow_update_stage parameter.
    // After T10 removes it, this assertion will pass.
    expect(result).not.toContain(legacyCriticOutcomeParam);
  });

  test("Orchestrator prompt describes Critic outcomes as Orchestrator decisions, not tool parameters", async () => {
    const result = await buildSystemPrompt(makeCtx({
      rolePrompt: criticContractRolePrompt,
      allowedTools: criticContractWorkflowTools,
    }));

    // Critic role and outcomes must be present in the prompt
    expect(result).toContain("Critic");
    expect(result).toContain("approved");
    expect(result).toContain("rejected");

    // After T10, Critic outcomes must be described as Orchestrator decisions
    // without mentioning the legacy Critic outcome field as a tool parameter.
    // Red phase: this FAILS while the prompt uses that field as a parameter.
    expect(result).not.toContain(legacyCriticOutcomeParam);
  });
});
