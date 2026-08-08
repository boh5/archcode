---
name: analyze-work
description: Synthesize architecture, difficult root-cause, or gap analysis into an evidence-backed recommendation when implementation direction is uncertain.
license: MIT
metadata:
  archcode/source: "Superpowers systematic-debugging concepts"
  archcode/source-commit: "44c9b2d6e889982ac18c27d05a19fefe335194e1"
  archcode/adaptation: "idea-only rewrite"
---

# Analyze Work

Produce a decision-ready analysis before implementation. Choose one primary mode below; combine modes only when the question genuinely spans them.

## Inputs

Establish the smallest complete brief:

- the question or failure to explain;
- the intended behavior, constraints, and observable success criteria;
- the relevant workspace, change range, runtime environment, or external contract;
- known evidence, attempted fixes, and explicit non-goals;
- the decision the Lead or user must make.

If a missing product choice would change the analysis materially, identify it instead of silently choosing. Use an Explore or Librarian child only for a separable evidence gap, and verify and synthesize the returned evidence yourself.

## Evidence Discipline

1. Reconstruct the current mechanism from primary evidence: code, tests, configuration, logs, history, and authoritative documentation.
2. Trace ownership and data flow across relevant boundaries. Record where validation, state mutation, persistence, concurrency, permissions, retries, and user-visible behavior actually live.
3. Keep four categories distinct:
   - **Observed:** directly supported by inspected evidence.
   - **Inferred:** the best explanation derived from observations.
   - **Falsified:** a plausible explanation contradicted by evidence.
   - **Unknown:** information not available or not safely testable.
4. Cite evidence precisely enough to recheck: file and symbol or line, command and material output, event sequence, or authoritative source and version.
5. Prefer the smallest decisive observation over broad inventory. Do not turn directory listings, child reports, or passing unrelated checks into proof.

For falsifiable diagnosis, boundary tracing, and deciding when to stop, read [references/diagnosis-method.md](references/diagnosis-method.md).

## Mode A: Architecture or Design

Use when choosing a mechanism, ownership boundary, migration, or concurrency model.

1. State the problem as an invariant or observable outcome, not as a preferred implementation.
2. Map the current design: entry points, owners, state transitions, trust boundaries, failure handling, and existing extension points.
3. Extract hard constraints from current behavior, architecture tests, persisted formats, compatibility promises, and user decisions. Separate those from habits that may be changed.
4. Define at least one viable minimal direction. Add alternatives only when they expose a real tradeoff; do not manufacture options.
5. Compare directions on correctness, complexity, coupling, operational risk, migration cost, reversibility, testability, and consistency with the product model.
6. Stress the preferred direction with failure cases: partial success, restart or retry, stale state, concurrency, cancellation, authorization, and rollback as relevant.
7. Recommend one direction, identify what it deliberately does not build, and name the smallest experiment or test that would invalidate the recommendation.

Reject designs that introduce a new service, state machine, identity, persistence layer, or abstraction without a demonstrated requirement that existing ownership cannot satisfy.

## Mode B: Root-Cause Diagnosis

Use for bugs, failures, regressions, and integration surprises. Define expected versus actual behavior, reproduce or inspect fresh evidence, trace the failing value or event across owners, then test one falsifiable hypothesis at a time. Classify the result as confirmed, probable, or unresolved; recommend a fix only after the causal mechanism is established.

## Mode C: Gap Analysis

Use when comparing a requirement, Plan, protocol, migration target, or acceptance contract with the current state.

1. Normalize the target into individually decidable obligations. Preserve explicit non-goals and distinguish requirements from examples.
2. For each obligation, locate current implementation and verification evidence.
3. Classify each obligation as satisfied, partially satisfied, missing, contradicted, or unverifiable. Never count file presence, intent, or a child claim as behavioral completion.
4. Trace dependencies between gaps so root omissions are not reported repeatedly as downstream symptoms.
5. Distinguish a defect from an intentional scope boundary, stale documentation, or optional improvement.
6. Order the minimum closure sequence and pair every proposed step with observable acceptance evidence.

## Severity and Confidence

Use severity for consequence, not emphasis: Blocker prevents a safe outcome; Major is a material correctness, data, security, compatibility, or acceptance failure; Minor is bounded; Advisory is optional. State confidence separately. High impact with uncertain evidence is a risk to investigate, not a confirmed finding.

## Stop Conditions

Stop and report the limitation when the governing objective is missing, the relevant artifact cannot be identified, evidence access is unavailable, a destructive or state-changing diagnostic would require new authority, or a required product decision cannot be inferred. Do not fill the gap with speculation.

## Output

Return a concise natural-language report containing:

1. mode, question, scope, and bottom-line recommendation or diagnosis;
2. current mechanism or target-versus-actual map;
3. observed facts, inferences, falsified hypotheses, and unknowns;
4. severity-ordered risks or gaps with exact evidence;
5. recommended direction, alternatives considered, and explicit non-goals;
6. smallest decisive validation and remaining decisions.

Do not modify source. The analysis informs the Lead; it does not transfer implementation or completion authority.
