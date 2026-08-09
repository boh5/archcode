import { describe, expect, test } from "bun:test";
import {
  applyMemoryReconciliation,
  buildMemoryReconciliationInput,
  filterUnsafeMemoryCandidates,
  splitMemoryBlocks,
  type MemoryReconciliationTarget,
} from "./reconciliation";
import {
  MAX_MEMORY_RECONCILIATION_INPUT_BYTES,
  MAX_MEMORY_TOUCHED_FILES,
  type MemoryExtractionCandidate,
  type MemoryReconciliationOperation,
} from "./learning-state";

function userCandidate(overrides: Partial<Extract<MemoryExtractionCandidate, { scope: "user" }>> = {}): Extract<MemoryExtractionCandidate, { scope: "user" }> {
  return {
    scope: "user",
    target: "preferences",
    content: "Prefer concise conclusions.",
    basis: "inferred",
    intent: "add",
    ...overrides,
  };
}

function projectCandidate(overrides: Partial<Extract<MemoryExtractionCandidate, { scope: "project" }>> = {}): Extract<MemoryExtractionCandidate, { scope: "project" }> {
  return {
    scope: "project",
    target: "build_tools",
    title: "Build Tools",
    description: "Build conventions",
    type: "project",
    content: "Use the repository build script.",
    basis: "inferred",
    intent: "add",
    ...overrides,
  };
}

function target(
  candidate: MemoryExtractionCandidate,
  document: string,
  exists = true,
): MemoryReconciliationTarget {
  return {
    scope: candidate.scope,
    name: candidate.target,
    document,
    exists,
    ...(candidate.scope === "project" && exists ? {
      rawDocument: `---\ntitle: ${candidate.title}\ndescription: ${candidate.description}\ntype: ${candidate.type}\n---\n${document}`,
    } : {}),
    ...(candidate.scope === "project" ? {
      topic: {
        title: candidate.title,
        description: candidate.description,
        type: candidate.type,
      },
    } : {}),
  };
}

describe("memory reconciliation", () => {
  test("renders complete numbered blocks and empty new-topic targets", () => {
    const existing = userCandidate();
    const fresh = projectCandidate();
    const input = buildMemoryReconciliationInput({
      candidates: [existing, fresh],
      targets: [
        target(existing, "first preference\n\n---\n\nsecond preference"),
        target(fresh, "", false),
      ],
      contextLimitTokens: 100_000,
    });
    expect(input.status).toBe("ready");
    if (input.status !== "ready") return;
    expect(input.prompt).toContain("[target scope=user name=preferences exists=true]");
    expect(input.prompt).toContain("[block 1]\nfirst preference");
    expect(input.prompt).toContain("[block 2]\nsecond preference");
    expect(input.prompt).toContain("[target scope=project name=build_tools exists=false]\n[mutable body]\n[empty target]");
    expect(input.inputBytes).toBeGreaterThan(0);
  });

  test("accepts an existing project topic with immutable type=user frontmatter", () => {
    const candidate = projectCandidate({ target: "personal_project_notes" });
    const document = "Existing note.";
    const input = buildMemoryReconciliationInput({
      candidates: [candidate],
      targets: [{
        scope: "project",
        name: candidate.target,
        document,
        rawDocument: `---\nname: Personal Project Notes\ndescription: Explicit topic\ntype: user\n---\n${document}`,
        exists: true,
        topic: {
          title: "Personal Project Notes",
          description: "Explicit topic",
          type: "user",
        },
      }],
      contextLimitTokens: 100_000,
    });

    expect(input.status).toBe("ready");
    if (input.status !== "ready") return;
    expect(input.prompt).toContain("type: user");
  });

  test("blocks rather than truncating touched files when the reconciliation budget is exceeded", () => {
    const candidate = projectCandidate({ content: "x".repeat(4_000) });
    const input = buildMemoryReconciliationInput({
      candidates: [candidate],
      targets: [target(candidate, "y".repeat(62_000))],
      contextLimitTokens: 100_000,
      hardMaxBytes: 1_000,
    });
    expect(input).toMatchObject({ status: "blocked", reason: "reconciliation_budget", maxBytes: 1_000 });
    expect(MAX_MEMORY_RECONCILIATION_INPUT_BYTES).toBe(64 * 1_024);
  });

  test("requires candidate targets and supplied complete files to match exactly", () => {
    const candidate = userCandidate();
    expect(() => buildMemoryReconciliationInput({
      candidates: [candidate],
      targets: [],
      contextLimitTokens: 100_000,
    })).toThrow("exactly match");
  });

  test("filters secret candidates before the reconciliation call", () => {
    const safe = userCandidate();
    const secret = projectCandidate({ content: "token=sk_test_1234567890abcdef" });
    const secretTitle = projectCandidate({
      target: "secret_title",
      title: "token=sk_test_abcdef1234567890",
    });
    const secretDescription = projectCandidate({
      target: "secret_description",
      description: "token=sk_test_fedcba0987654321",
    });
    expect(filterUnsafeMemoryCandidates([
      safe,
      secret,
      secretTitle,
      secretDescription,
    ])).toEqual([safe]);
  });

  test("applies NOOP without changing the complete target document", () => {
    const candidate = userCandidate();
    const document = "first preference\n\n---\n\nsecond preference";
    const operations: MemoryReconciliationOperation[] = [{
      scope: "user",
      target: "preferences",
      action: "NOOP",
    }];
    expect(applyMemoryReconciliation({
      candidates: [candidate],
      targets: [target(candidate, document)],
      operations,
    })).toEqual(new Map([["user\0preferences", document]]));
  });

  test("ADD appends exactly one canonical block and supports a new topic", () => {
    const existing = userCandidate();
    const fresh = projectCandidate();
    const operations: MemoryReconciliationOperation[] = [
      { scope: "user", target: "preferences", action: "ADD", content: "New preference" },
      { scope: "project", target: "build_tools", action: "ADD", content: "New build rule" },
    ];
    const result = applyMemoryReconciliation({
      candidates: [existing, fresh],
      targets: [target(existing, "Existing preference"), target(fresh, "", false)],
      operations,
    });
    expect(result.get("user\0preferences")).toBe("Existing preference\n\n---\n\nNew preference");
    expect(result.get("project\0build_tools")).toBe("New build rule");
  });

  test("UPDATE can replace or merge cited blocks only for an explicit correction", () => {
    const candidate = userCandidate({
      basis: "explicit",
      intent: "correct",
      content: "Prefer direct conclusions.",
    });
    const document = "old preference\n\n---\n\nkeep this unrelated block\n\n---\n\nold duplicate";
    const operations: MemoryReconciliationOperation[] = [{
      scope: "user",
      target: "preferences",
      action: "UPDATE",
      blockIds: [1, 3],
      content: candidate.content,
    }];
    const result = applyMemoryReconciliation({
      candidates: [candidate],
      targets: [target(candidate, document)],
      operations,
    });
    expect(result.get("user\0preferences")).toBe("Prefer direct conclusions.\n\n---\n\nkeep this unrelated block");
  });

  test("rejects inferred UPDATE, missing targets, invalid block ids, and secret output", () => {
    const inferred = userCandidate();
    expect(() => applyMemoryReconciliation({
      candidates: [inferred],
      targets: [target(inferred, "old")],
      operations: [{ scope: "user", target: "preferences", action: "UPDATE", blockIds: [1], content: "new" }],
    })).toThrow("explicit user correction");

    const missing = projectCandidate({ basis: "explicit", intent: "correct" });
    expect(() => applyMemoryReconciliation({
      candidates: [missing],
      targets: [target(missing, "", false)],
      operations: [{ scope: "project", target: "build_tools", action: "UPDATE", blockIds: [1], content: "new" }],
    })).toThrow("missing Memory");

    const explicit = userCandidate({ basis: "explicit", intent: "correct" });
    expect(() => applyMemoryReconciliation({
      candidates: [explicit],
      targets: [target(explicit, "old")],
      operations: [{ scope: "user", target: "preferences", action: "UPDATE", blockIds: [2], content: "new" }],
    })).toThrow("missing block");

    expect(() => applyMemoryReconciliation({
      candidates: [userCandidate()],
      targets: [target(userCandidate(), "old")],
      operations: [{ scope: "user", target: "preferences", action: "ADD", content: "token=sk_test_1234567890abcdef" }],
    })).toThrow("secret pattern");
  });

  test("forced NOOP markers cannot be reconciled again", () => {
    const candidate = userCandidate();
    expect(() => applyMemoryReconciliation({
      candidates: [candidate],
      targets: [target(candidate, "old")],
      operations: [{ scope: "user", target: "preferences", action: "NOOP" }],
      forcedNoopTargets: [{ scope: "user", target: "preferences" }],
    })).toThrow("cannot also be reconciled");
  });

  test("splits only the canonical divider and keeps block text byte-for-byte", () => {
    expect(splitMemoryBlocks("one\n\n---\n\ntwo")).toEqual(["one", "two"]);
    expect(splitMemoryBlocks("single block without divider")).toEqual(["single block without divider"]);
    expect(splitMemoryBlocks("")).toEqual([]);
    expect(MAX_MEMORY_TOUCHED_FILES).toBe(4);
  });
});
