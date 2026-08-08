---
name: review-work
description: Let Lead assemble evidence, choose proportionate independent review, and drive fix-review closure when completed work needs criticism before delivery.
license: MIT
metadata:
  archcode/source: "Superpowers review and verification concepts"
  archcode/source-commit: "44c9b2d6e889982ac18c27d05a19fefe335194e1"
  archcode/adaptation: "idea-only rewrite"
---

# Review Work

Lead owns the review outcome: define what is being reviewed, obtain proportionate independent criticism, verify every material finding, drive remediation, and report the final evidence. A review is a workflow step, not new persisted Review state.

For a review-packet checklist and remediation-loop detail, read [references/review-packet.md](references/review-packet.md). Do not duplicate the Analyst's `review-change` method.

## Inputs

Resolve the objective and exact attributable change boundary before choosing a reviewer. Review cannot compensate for an undefined contract.

## Choose the Review Depth

Direct Lead verification may be sufficient for a small, obvious, low-risk change with narrow impact and decisive checks. Use an independent Analyst when any of these apply:

- behavior spans components, persistence, concurrency, permissions, security, migrations, or compatibility;
- the change is large, ambiguous, difficult to reverse, or based on uncertain assumptions;
- diagnosis or implementation required several iterations;
- acceptance depends on more than a single mechanical check;
- independent criticism is explicitly requested or required before Goal completion.

Default to one Analyst and give it all relevant review lenses. Add another only for a genuinely independent specialty or disputed high-impact finding; do not duplicate the same review for ceremony.

## Prepare an Independent Review

Give the Analyst a precise brief, not the whole Session narrative and not a desired verdict:

- what must be true;
- what changed and the exact baseline or paths;
- what evidence already exists;
- which risks or assumptions deserve adversarial attention;
- which artifacts are unrelated and out of scope.

Activate `review-change` for ordinary Plan or implementation review. The Analyst remains read-only. Use Explore or Librarian only through the established delegation boundaries for narrow evidence questions; do not invent new responsibilities or permissions.

## Evaluate Feedback Technically

For every proposed finding:

1. Understand the exact claimed failure and affected requirement.
2. Verify it against current code, tests, product behavior, and architecture constraints.
3. Classify it as confirmed, false positive, already prevented elsewhere, unresolved question, or optional improvement.
4. Assign consequence-based severity:
   - **Blocker:** unsafe to proceed or stated outcome defeated.
   - **Major:** material correctness, security, data, compatibility, or acceptance defect.
   - **Minor:** bounded defect or meaningful verification weakness.
   - **Advisory:** optional simplification or future hardening.
5. Push back on technically incorrect, out-of-scope, or overdesigned advice with evidence. Never implement feedback merely because a reviewer stated it confidently.

## Remediation Loop

Resolve Blocker and Major findings before delivery, make the smallest root-cause correction, run fresh narrow then proportionate broad checks, and re-review whenever remediation changes the reviewed risk boundary. Check disputed evidence yourself before multiplying reviewers; return to diagnosis when repeated fixes do not add evidence.

## Goal Boundary

For Goal completion, follow `run-goal`: after implementation, fresh verification, and terminal children, create a fresh direct `deep` Analyst with `goal-review`. If remediation changes the final state, obtain another fresh Goal review. The Lead interprets the complete natural-language report and alone decides whether evidence supports calling `update_goal`; the reviewer and Skill do not control Goal state.

## Stop Conditions

Stop the review loop and report the exact limitation when:

- the objective, baseline, or final change surface cannot be established;
- a finding depends on a missing product decision;
- required verification is unavailable, unsafe, or needs new authority;
- remediation would expand scope materially beyond the user's authorization;
- evidence remains contradictory after the smallest discriminating checks.

Do not convert missing evidence into approval or failure. State what can and cannot be concluded and the next decisive action.

## Output

Report:

1. objective, scope, baseline, and review depth chosen;
2. who or what reviewed which surface;
3. confirmed findings in severity order, plus false positives or disputed items that materially affected the decision;
4. fixes made and the exact evidence that rechecked them;
5. fresh verification commands and outcomes;
6. unresolved Minor findings, residual risk, and anything not verified;
7. the current delivery status in plain language.

Never imply that review alone proves completion. The final status must match the newest attributable code and fresh verification evidence.
