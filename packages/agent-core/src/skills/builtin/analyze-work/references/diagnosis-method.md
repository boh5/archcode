# Falsifiable diagnosis method

Use this only when the task is diagnosis rather than broad design.

## Investigation record

Keep one compact record so evidence does not get replaced by the latest theory:

| Field | Record |
| --- | --- |
| Expected / actual | One observable difference, not “it fails” |
| Reproduction | Exact input, environment, first bad result, and complete error |
| Working comparison | Nearest path that succeeds under comparable conditions |
| First divergent boundary | Owner, input, output, state/configuration, and timestamp/order |
| Current hypothesis | `X causes Y because Z` |
| Discriminating observation | Result that would confirm it and result that would falsify it |

## Probe loop

1. Reproduce or obtain fresh evidence before explaining the cause. If the failure is intermittent, record frequency and the smallest known precondition.
2. Compare the failing path with a nearby working path. Trace the wrong value, state, or event backwards from the first visible symptom; do not start at the component you already suspect.
3. At every crossed boundary, identify the owner and capture the value before and after validation, transformation, persistence, queueing, retry, or permission checks.
4. State one hypothesis in falsifiable form. Prefer a probe that observes existing state; if a state-changing probe is necessary, obtain authority and isolate its effect.
5. Change one variable or inspect one boundary. Record the result as confirmed, falsified, or inconclusive before forming the next hypothesis.
6. Reproduce the repaired path and the nearest working comparison. Then run the narrow regression check that would fail if the causal mechanism returned.

## Claim quality

- **Confirmed cause:** the mechanism explains the symptom, the decisive probe isolates it, and the proposed fix acts at that mechanism.
- **Probable cause:** evidence points to one mechanism but a decisive observation is unavailable; state confidence and the missing probe.
- **Unresolved:** multiple mechanisms remain viable or evidence conflicts; list the next observation that would distinguish them.

“The error disappeared after several edits” is not causal proof. Neither is a stack trace that only shows where the failure surfaced, a child report without inspected evidence, or a configuration difference without a demonstrated path to the symptom.

After three inconsistent hypotheses, stop patching. Recheck the architecture and assumptions and surface the impasse.
