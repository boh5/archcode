# Review packet and remediation loop

Use this packet to let an independent reviewer reconstruct the work without steering it toward approval.

```markdown
## Contract
- Objective and acceptance criteria:
- Constraints / non-goals / user decisions:

## Attributable surface
- Baseline commit or artifact:
- Final diff, files, schemas, migrations, generated artifacts:
- Unrelated work explicitly excluded:

## Implementation map
- Changed owners and interfaces:
- State/data/event flow affected:
- Failure, retry, permission, persistence, or compatibility boundaries:

## Verification
| Claim | Fresh command/inspection | Environment | Exit/material result | Limitation |
| --- | --- | --- | --- | --- |

## Challenge targets
- Known risks and assumptions:
- Decisions that must not be reopened:
- Evidence gaps or checks not run:
```

Do not include a desired verdict or tell the reviewer that another reviewer already approved. Include failed checks and known limitations; omitting them makes the packet less independent, not more persuasive.

For each confirmed finding, record classification, severity, correction, and fresh proof. Re-review after a material correction changes the reviewed behavior or invalidates prior evidence. Stop for a decision or external limit; do not treat missing evidence as approval.

| Finding | Verified? | Correction | Affected acceptance | Fresh proof | Re-review |
| --- | --- | --- | --- | --- | --- |
| <exact issue> | yes/no | <smallest adequate fix> | <criterion> | <command/result> | open/closed |

Lead should independently reproduce or inspect material findings before changing code. Reject false positives with evidence. After a fix, rerun the narrow regression and every broader check invalidated by the change, then ask the reviewer to recheck the full affected acceptance condition—not only the edited line.
