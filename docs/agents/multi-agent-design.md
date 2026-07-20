# Multi-Agent Architecture

ArchCode has seven closed Agent identities. An identity determines prompt,
tools, delegation targets, model configuration, and display metadata. A Session
persists one `agentName`; an Execution reconstructs that Agent and never changes
the identity per turn.

| ID | Display name | Purpose |
|---|---|---|
| `engineer` | Engineer | Root Session Agent. Owns the user conversation, implements directly or delegates, and may create a Session Goal from an explicit user request. |
| `plan` | Plan | Read-only planning specialist. |
| `build` | Build | Source-writing implementation specialist. |
| `reviewer` | Reviewer | Read-only independent verifier. Runtime creates a dedicated Reviewer child when a Session Goal needs a completion gate. |
| `explore` | Explore | Terminal read-only local-code investigation. |
| `librarian` | Librarian | Terminal read-only documentation and reference research. |
| `shaper` | Shaper | Refines a bound Project Todo without starting implementation. |

## Sessions and Goals

`Session.goal` is an optional, durable execution protocol owned by a root
Engineer Session. It is not an Agent identity, independent resource, worktree,
or route family.

- An Engineer creates it only after a fresh, explicit user request; ordinary
  conversation is still the default.
- The Goal stores one objective, status, budget/usage, evaluator outcome, and
  review state. The objective includes the intended result, constraints, and
  verification expectation rather than splitting them into model-editable
  acceptance fields.
- The user control plane may edit, pause, resume, clear, or adjust its budget.
  An edit takes effect at the next model-call boundary; pause is the immediate
  stop control.
- The Engineer may read the Goal, mark a genuine blocker, or request review. It
  cannot complete, edit, pause, resume, clear, or increase its Goal.
- Runtime owns completion: it evaluates the objective, then runs an independent
  Reviewer gate. Only an accepted current review receipt completes the Goal.

## Runtime sequencing

When a root Session family becomes idle, the runtime resolves work in this
order: durable tool/HITL waits, queued user input, an already requested review,
review remediation, evaluator, then Goal continuation. The current Goal is
injected before every model call, so edits and resumes are observed without a
second coordinator Session.

Reviewer work is a runtime-created child with explicit review provenance and a
snapshot of the objective and source basis. It uses the normal read-only
Reviewer capability surface, returns the canonical child result, and cannot use
Goal transition tools. A changed objective, new user input, or source mutation
invalidates a stale review basis.

## Delegation

```text
Engineer ─┬─ Plan ───────┬─ Explore
          ├─ Build ──────┤
          ├─ Reviewer ───┴─ Librarian
          ├─ Explore
          └─ Librarian
```

- Engineer may delegate to all five specialists.
- Plan and Reviewer may delegate to Explore and Librarian.
- Build may delegate to Explore.
- Explore and Librarian are terminal.
- Delegation depth and concurrency are enforced by definitions, not prompts.

Specialist prompts stay context-neutral. A dedicated runtime Reviewer receives
the Goal review contract explicitly; ordinary Reviewer delegations do not gain
Goal-completion authority.

## UI metadata and configuration

`AgentDefinition.displayName` is the single display-name source. Runtime
exposes the definitions through `GET /api/agents`; the Web uses that catalog for
message headers, inspectors, and delegation cards. Task titles remain separate
from Agent display names.

The server-wide `~/.archcode/config.json` requires exactly the seven current
Agent keys under `agents`. Missing, unknown, or legacy keys fail validation.
Display names are definition-owned and are not configurable.
