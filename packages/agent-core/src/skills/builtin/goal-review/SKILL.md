---
name: goal-review
description: Perform an independent evidence-based final review in a fresh direct deep Analyst Session before a Goal completes.
license: MIT
metadata:
  archcode/source: "ArchCode Goal review protocol"
  archcode/source-commit: "f00efe7ab3cd87f951797d9b4bf14415f10abd7a"
  archcode/adaptation: "original rewrite"
---

# Goal Review

Perform a fresh, independent, read-only review of the final Goal result. Produce an ordinary natural-language evidence report for the Lead. This Skill does not own Goal state and does not define a Runtime-parsed approval token or verdict protocol.

## Required Inputs

Establish from the current review brief and repository evidence:

- the complete Goal objective and all observable acceptance criteria;
- explicit constraints, non-goals, and user decisions;
- the final attributable changes and baseline;
- the implementation and remediation history only where it explains current risk;
- fresh verification evidence for the final state;
- known limitations, deferred work, and operational or migration requirements.

Do not reconstruct a missing Goal objective from a Plan, diff, or earlier summary. If the authoritative objective or final change surface is unavailable, stop and explain why an independent completion assessment is not possible.

## Independence Rules

- Inspect primary evidence yourself: current code, diff, tests, configuration, persisted formats, logs, and authoritative documentation as relevant.
- Treat Lead, Build, and prior reviewer summaries as pointers, not proof.
- Use read-only Explore or Librarian children only for separable evidence questions, then check and synthesize their evidence yourself.
- Do not modify source, propose opportunistic refactors, resume implementation, or soften a finding to help the Goal finish.
- Review the current final state. A report issued before later remediation is stale and cannot cover that remediation.

## Review Method

### 1. Normalize the Goal contract

Translate the objective into a checklist of individually observable obligations. Preserve scope boundaries. Identify acceptance criteria that are ambiguous or not decidable and state the missing decision rather than inventing one.

### 2. Build an evidence matrix

Use [references/evidence-matrix-example.md](references/evidence-matrix-example.md) as a compact readable model; it is not a machine verdict.

For every obligation, record:

- the implementation or artifact that satisfies it;
- the exact verification evidence and freshness;
- relevant negative or edge cases;
- status as supported, partially supported, unsupported, contradicted, or unverifiable.

File existence, code plausibility, an old test run, or an agent's completion claim is not sufficient evidence of behavior.

### 3. Inspect the final change end to end

Trace affected behavior across relevant callers and boundaries. Check:

- correctness and preservation of existing behavior;
- persistence, migrations, restart, retry, and rollback or recovery;
- concurrency, cancellation, partial failure, cleanup, and idempotency;
- permissions, trust boundaries, secret handling, validation, and destructive actions;
- public types, compatibility, configuration, error mapping, and user-visible states;
- scope discipline: required work is present and unrelated machinery was not introduced.

### 4. Challenge the verification

Map each completion claim to the command, observation, or artifact that proves it. Confirm that evidence was produced against the final attributable state, inspect full material output and exit status, and identify what the check cannot prove. Prefer fresh targeted regression evidence plus proportionate broader checks.

When a test was added for a bug, look for evidence that it detects the original failure rather than merely passing with the current code. When a check could not be run, report that as a verification gap; do not infer success.

### 5. Verify candidate findings

Before reporting a defect, identify the violated Goal obligation or invariant, cite exact evidence, trace a concrete failure path and impact, and check whether another layer prevents it. Separate confirmed defects from questions and optional improvements.

## Severity

- **Blocker:** evidence shows the Goal's core outcome is not achieved or proceeding would create severe security, data, or operational harm.
- **Major:** a material correctness, acceptance, security, compatibility, persistence, or migration gap remains.
- **Minor:** a bounded defect or meaningful verification weakness that does not defeat the core outcome.
- **Advisory:** optional cleanup or future hardening outside the completion decision.

Severity is about consequence and likelihood, not implementation effort. State uncertainty separately. An unverified high-impact possibility is a verification gap, not automatically a confirmed Blocker.

## Completion Assessment

Use ordinary prose to explain whether the inspected evidence supports the Goal objective or whether material gaps remain. The assessment must follow the evidence matrix:

- any confirmed Blocker or Major gap means required remediation remains;
- an unverifiable required criterion means the report cannot support a confident completion conclusion;
- Minor or Advisory items may remain only when they do not contradict the objective or agreed acceptance criteria, and they must be disclosed;
- no findings does not mean perfect software; describe the reviewed scope and residual risk.

Do not emit `PASS`, `FAIL`, a magic prefix, JSON verdict, score, or any other machine-oriented completion signal. The Lead reads the entire report, resolves material gaps, performs its own verification, and decides whether Goal completion is appropriate.

## Stop Conditions

Return an unable-to-conclude report instead of guessing when:

- the Goal objective, acceptance criteria, baseline, or final changes are missing or inconsistent;
- primary evidence cannot be accessed;
- required verification needs mutation, credentials, environment access, or authority not available to the Analyst;
- a product decision is required to decide whether an obligation is satisfied;
- the final state changes during review.

Name the missing evidence and the smallest step needed for a fresh review.

## Output

Write a natural-language report with:

1. a short completion assessment and the exact scope reviewed;
2. the criterion-by-criterion evidence matrix or equivalent readable mapping;
3. findings in severity order, each with requirement, evidence, failure path, impact, and smallest remediation or proof needed;
4. verification commands or observations checked, material results, freshness, and limitations;
5. missing evidence, unresolved questions, and residual risk;
6. a clear statement of what the evidence supports and what remains for the Lead to decide.

Do not call or recommend a Goal state mutation as if it were the reviewer's action. This report is independent evidence, not completion authority.
