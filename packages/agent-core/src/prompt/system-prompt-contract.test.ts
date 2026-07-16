import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "./builder";
import type { PromptContext } from "./types";
import {
  agentDefinitions,
  buildAgentDefinition,
  engineerAgentDefinition,
  exploreAgentDefinition,
  goalLeadAgentDefinition,
  librarianAgentDefinition,
  planAgentDefinition,
  reviewerAgentDefinition,
  shaperAgentDefinition,
} from "../agents/definitions";

const ENV: PromptContext["env"] = {
  platform: "darwin",
  timezone: "Asia/Shanghai",
  locale: "zh-CN",
  projectRoot: "/workspace",
  cwd: "/workspace",
  versionControl: "git",
  date: "2026-07-12",
};

async function fullPrompt(definition: (typeof agentDefinitions)[number]): Promise<string> {
  return buildSystemPrompt({
    allowedTools: definition.tools.tools,
    promptProfileId: definition.promptProfileId,
    rolePrompt: definition.rolePrompt,
    env: ENV,
  });
}

const STRUCTURAL_POLICY_EXAMPLES = {
  direct: {
    scenario: "Change one known line in packages/utils/src/format-time.ts and run its one targeted test.",
    requiredClauses: ["all six conditions", "one localized deliverable"],
    guardClauses: ["Do not delegate simple work for ceremony"],
  },
  "research-first": {
    scenario: "Change behavior across server and web workspaces.",
    requiredClauses: ["2-4 distinct research children", "at least one Explore child"],
    guardClauses: ["before a substantive conclusion or dependent source edit"],
  },
  "explore-and-librarian": {
    scenario: "Adapt integration to the current external API behavior.",
    requiredClauses: ["external library, API, current-version behavior", "Librarian"],
    guardClauses: ["Do not guess external facts"],
  },
  "background-overlap": {
    scenario: "Implement two independent modules with disjoint files.",
    requiredClauses: ["disjoint file or module ownership", "background=true"],
    guardClauses: ["Do not overlap shared interfaces"],
  },
  sequential: {
    scenario: "Update two consumers of the same public interface.",
    requiredClauses: ["shared file, public interface, or dependency", "run sequentially"],
    guardClauses: ["Do not create conflicting owners"],
  },
} as const;

describe("full system prompt contracts", () => {
  test("all eight agents receive the common execution contract without internal profile labels", async () => {
    for (const definition of agentDefinitions) {
      const prompt = await fullPrompt(definition);
      expect(prompt).toContain("## Execution Contract");
      expect(prompt).toContain("inspect evidence");
      expect(prompt).toContain("narrowest meaningful verification");
      expect(prompt).toContain("genuine blocker");
      expect(prompt).not.toContain("prompt profile");
    }
  });

  test("delegating agents receive the protocol while terminal agents do not", async () => {
    for (const definition of [
      engineerAgentDefinition,
      goalLeadAgentDefinition,
      planAgentDefinition,
      buildAgentDefinition,
      reviewerAgentDefinition,
      shaperAgentDefinition,
    ]) {
      expect(await fullPrompt(definition)).toContain("## Delegation Protocol");
    }
    for (const definition of [exploreAgentDefinition, librarianAgentDefinition]) {
      expect(await fullPrompt(definition)).not.toContain("## Delegation Protocol");
    }
  });

  test("centralizes the version-control condition in the Environment section", async () => {
    const invariant = "Git-specific instructions elsewhere in this prompt apply only when Version control is git";

    for (const definition of agentDefinitions) {
      const prompt = await fullPrompt(definition);
      expect(prompt).toContain(invariant);
      expect(prompt.split(invariant)).toHaveLength(2);
      expect(definition.rolePrompt ?? "").not.toMatch(/version control is available/i);
    }
  });

  test("Engineer receives the complete current-intent gate without an automatic-change rule", async () => {
    const prompt = await fullPrompt(engineerAgentDefinition);

    for (const clause of [
      "answer, report, or review request",
      "inspect and explain without changing source or external state",
      "diagnose request",
      "Do not implement a fix unless the user also authorizes change",
      "change, build, or fix request",
      "implementation and verification",
      "monitor or wait request",
      "remain active until the stated terminal condition",
      'A short confirmation such as "continue" inherits the already agreed intent',
    ]) {
      expect(prompt).toContain(clause);
    }
    expect(prompt).not.toContain("always implement");
    expect(prompt).not.toContain("immediately modify source");
  });

  for (const [policy, example] of Object.entries(STRUCTURAL_POLICY_EXAMPLES)) {
    test(`root structural policy ${policy}: ${example.scenario}`, async () => {
      for (const definition of [engineerAgentDefinition, goalLeadAgentDefinition]) {
        const prompt = await fullPrompt(definition);
        for (const clause of example.requiredClauses) expect(prompt).toContain(clause);
        for (const guard of example.guardClauses) expect(prompt).toContain(guard);
      }
    });
  }

  test("non-orchestrating delegating roles reuse upstream evidence and never receive implementation-child instructions", async () => {
    for (const definition of [planAgentDefinition, buildAgentDefinition, reviewerAgentDefinition, shaperAgentDefinition]) {
      const prompt = await fullPrompt(definition);
      expect(prompt).toContain("Reuse sufficient upstream evidence");
      expect(prompt).toContain("Do not repeat research for ceremony");
      expect(prompt).toContain("Research delegation never grants implementation authority");
      expect(prompt).toContain("Only Engineer and Goal Lead may delegate source changes to Build");
      expect(prompt).not.toContain("2-4 distinct research children");
      expect(prompt).not.toContain("start independent Build units with background=true");
    }
  });

  test("only Engineer and Goal Lead orchestrate concurrent Build children", async () => {
    for (const definition of [engineerAgentDefinition, goalLeadAgentDefinition]) {
      const prompt = await fullPrompt(definition);
      expect(prompt).toContain("start independent Build units with background=true");
      expect(prompt).toContain("Do not overlap shared interfaces");
    }
  });

  test("role deltas remain specific and directly consumable", async () => {
    const engineer = await fullPrompt(engineerAgentDefinition);
    const goalLead = await fullPrompt(goalLeadAgentDefinition);
    const plan = await fullPrompt(planAgentDefinition);
    const build = await fullPrompt(buildAgentDefinition);
    const reviewer = await fullPrompt(reviewerAgentDefinition);
    const explore = await fullPrompt(exploreAgentDefinition);
    const librarian = await fullPrompt(librarianAgentDefinition);
    const shaper = await fullPrompt(shaperAgentDefinition);

    expect(engineer).toContain("goal_create");
    expect(engineer).toContain("explicit one-time or recurring time-triggered intent");
    expect(engineer).toContain("if ignored or declined, continue this Session and do not repeat it for the same intent");
    expect(engineer).toContain("Never create before the user explicitly confirms");
    expect(engineer).toContain("a material summary change requires confirmation again");
    expect(engineer).toContain("cannot be split without coordination overhead");
    expect(goalLead).toContain("action=begin_review");
    expect(goalLead).toContain("reviewGeneration");
    expect(goalLead).toContain("Delegate every source mutation to Build");
    for (const field of ["Evidence", "Scope and non-goals", "Ordered file-level steps", "Verification", "Risks", "Build and Reviewer handoff"]) {
      expect(plan).toContain(field);
    }
    expect(build).toContain("Bug, state-machine, protocol, and core-logic changes");
    expect(build).toContain("Documentation, simple configuration, and mechanical refactors");
    expect(build).toContain("return the missing prerequisite to the parent");
    expect(reviewer).toContain("skeptical of claims and neutral about the verdict");
    expect(reviewer).toContain("acceptance criterion -> evidence -> pass/fail");
    expect(explore).toContain("quick");
    expect(explore).toContain("medium");
    expect(explore).toContain("thorough");
    expect(explore).toContain("Search coverage");
    expect(librarian).toContain("Conceptual, implementation, history, or comprehensive");
    expect(librarian).toContain("immutable commit permalink");
    expect(librarian).toContain("Source quality");
    expect(shaper).toContain("project_todo_update");
    expect(shaper).toContain("do not implement it");
    expect(shaper).toContain("explicitly requests or confirms");
    expect(shaper).toContain("Use keep_current for title/body corrections");
    expect(shaper).toContain("never downgrade an existing Ready or Rejected Todo by default");
    expect(shaper).toContain("Never use Bash to modify source");
    expect(shaper).toContain("Recommend Idea, Ready, or Rejected");
  });

  test("read-only and Goal authority boundaries remain explicit", async () => {
    const goalLead = await fullPrompt(goalLeadAgentDefinition);
    const plan = await fullPrompt(planAgentDefinition);
    const reviewer = await fullPrompt(reviewerAgentDefinition);
    const explore = await fullPrompt(exploreAgentDefinition);
    const librarian = await fullPrompt(librarianAgentDefinition);

    expect(goalLead).toContain("Do not write or edit source files");
    expect(plan).toContain("source read-only");
    expect(reviewer).toContain("Bash is available only for inspection and verification");
    expect(explore).toContain("terminal read-only");
    expect(librarian).toContain("terminal read-only");
    expect(goalLead).not.toContain("goal_create");
    expect(reviewer).toContain("goal_manage.finalize_review");
    expect(reviewer).toContain("Insufficient evidence means NOT_DONE");
    expect(reviewer).toContain('A child or implementer saying "done" is never evidence');
  });
});
