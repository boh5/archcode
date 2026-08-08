---
name: review-change
description: Independently review a Plan or implementation for correctness, completeness, safety, and verifiability in an Analyst Session.
license: MIT
metadata:
  archcode/source: "Superpowers review and verification concepts"
  archcode/source-commit: "44c9b2d6e889982ac18c27d05a19fefe335194e1"
  archcode/adaptation: "idea-only rewrite"
---

# Review Change

Perform an independent, read-only review of a defined Plan or implementation. The purpose is to find material problems and explain them with reproducible evidence, not to approve by tone or reward complexity.

For lens prompts, finding quality, severity/confidence, and unable-to-conclude examples, read [references/review-lenses.md](references/review-lenses.md).

## Required Inputs

Before reviewing, identify:

- the governing objective, acceptance criteria, constraints, and non-goals;
- the exact Plan, diff, commits, files, or other attributable change surface;
- the baseline against which the change is judged;
- verification already run, including commands, environment, and results;
- known risks or questions the requester wants challenged.

If the change surface or governing requirement is ambiguous, stop and request a precise boundary. Do not review the entire repository as a substitute.

## Review Procedure

### 1. Reconstruct the contract

Restate what must remain true before reading the proposed solution in detail. Locate primary evidence for the requirement and current behavior. Separate explicit acceptance criteria from assumptions and optional improvements.

### 2. Establish the attributable change

Inspect the actual diff or Plan, not only a summary. Check for unstated generated files, migrations, configuration, schema changes, or call sites needed to make the change work. Preserve unrelated workspace changes outside the review conclusion.

### 3. Trace affected behavior

Follow each material path from entry to observable outcome. Inspect, as relevant:

- callers, consumers, public types, and compatibility boundaries;
- validation, permissions, trust boundaries, secret handling, and destructive actions;
- persistence, migrations, restart and retry behavior;
- concurrency, cancellation, partial failure, cleanup, and idempotency;
- error mapping, logging, auditability, and user-visible states;
- tests that prove the changed behavior and protect the failure mode.

Use nearby working implementations and architecture constraints as comparison evidence. A stylistic preference is not a defect.

### 4. Apply the appropriate lens

Choose only relevant Plan, code, and security lenses. Trace every claimed problem from requirement through concrete failure path and check whether another layer already prevents it.

### 5. Verify each candidate finding

Before reporting a finding:

1. state the violated requirement or invariant;
2. cite the exact code, Plan text, runtime evidence, or missing verification;
3. trace a concrete input or state to the harmful outcome;
4. check whether another layer already prevents it;
5. state the smallest correction or acceptance test, without designing the implementation unnecessarily.

If the issue cannot survive this check, omit it or label it as an open question. Validate external or child feedback against the repository; do not forward it blindly.

### 6. Assess verification

Match evidence to claims. A typecheck does not prove runtime behavior; a unit test does not prove an integration boundary; a passing test added after the fix does not by itself prove it detects the regression. Run safe, proportionate read-only checks when useful. Otherwise state exactly what was not run and why.

## Severity

Use Blocker for unsafe or objective-defeating work, Major for a material reproducible defect, Minor for a bounded defect or meaningful verification weakness, and Advisory for optional future work. Severity reflects consequence and likelihood, not fix size; state uncertainty separately.

## Stop Conditions

Stop and return an “unable to conclude” report when the objective, baseline, or attributable change cannot be established; required evidence is inaccessible; or verification would require mutation or authority the Analyst does not have. Name the missing evidence and the smallest next step.

Do not modify source, resolve findings, or claim delivery completion. When `goal-review` is active, follow that Skill's final-Goal evidence method and output requirements rather than turning this into a second verdict format.

## Output

Lead with the findings, ordered by severity. Each actionable finding must include:

- severity and short title;
- violated requirement or invariant;
- exact evidence location;
- concrete failure scenario and impact;
- smallest acceptable correction or verification.

Then include:

- review scope and baseline;
- checks run and material results;
- open questions or verification gaps;
- residual risks and advisory observations;
- a plain-language overall assessment.

If there are no actionable findings, say so directly but still state scope, evidence checked, checks not run, and residual risk. “No findings” means none were supported by the reviewed evidence, not that the change is proven perfect.
