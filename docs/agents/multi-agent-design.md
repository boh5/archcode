# Multi-Agent Architecture

ArchCode has seven closed Agent identities. An Agent identity determines prompt, tools, delegation targets, model configuration, and UI display metadata. A Session persists exactly one identity in `agentName`; execution always reconstructs that Agent and cannot override it per turn.

| ID | Display name | Purpose |
|---|---|---|
| `engineer` | Engineer | Default ordinary Session Agent; investigates, implements, reviews, and may create confirmed Goals or Automations. |
| `goal_lead` | Goal Lead | Root Agent for an already-created and server-started Goal; coordinates lifecycle and specialists without direct source mutation. |
| `plan` | Plan | Read-only planning for ordinary, Loop, or Goal work. |
| `build` | Build | Source-writing implementation specialist. |
| `reviewer` | Reviewer | Read-only independent review; finalizes only Goal-bound reviews. |
| `explore` | Explore | Terminal read-only local code investigation. |
| `librarian` | Librarian | Terminal read-only documentation and reference research. |

## Root Session selection

- `POST /sessions` creates an `engineer` Session.
- `GoalLifecycleService` creates or recovers the stable `goal_lead` root Session with `sessionRole: "main"` and the Goal binding; retry reuses that identity.
- Child delegation persists the selected specialist identity before execution.
- Loaded Session files must contain a valid current Agent ID. There are no aliases or legacy-name fallbacks.

`SessionRole` remains execution-topology metadata used by Goal and delegation flows. It does not select capabilities; `agentName` is the sole Agent identity.

## Goal authority

Goal creation is one product action with an internal recoverable commit/activate boundary:

- After the user confirms the creation Skill summary, an unbound ordinary Engineer root may call `goal_create` with the confirmed objective, acceptance criteria, and worktree choice.
- `GoalLifecycleService` is the sole initial creation/activation owner: it atomically commits the running Goal with stable Goal and main Session IDs, then idempotently prepares the workspace, persists the independent Goal Lead root Session, and starts execution.
- There is no Goal Draft state, Draft update API, or manual initial Run route. Retry applies only to an existing failed or not-done Goal and reuses its stable execution identity.
- Model-facing `goal_manage` has no `create` or `start` action.
- Goal Lead uses `goal_manage` for the lifecycle of its already-started Goal.
- Reviewer may call `goal_manage.finalize_review` only from the matching Goal review Session.

The committed Goal publishes a resource change immediately and queues asynchronous title generation, so Web consumers see the running Goal without waiting for an incidental refetch.

## Delegation

```text
Engineer ─┬─ Plan ───────┬─ Explore
          ├─ Build ──────┤
          ├─ Reviewer ───┴─ Librarian
          ├─ Explore
          └─ Librarian

Goal Lead uses the same specialist set.
```

- Engineer and Goal Lead may delegate to all five specialists.
- Plan and Reviewer may delegate to Explore and Librarian.
- Build may delegate to Explore.
- Explore and Librarian are terminal.
- Delegation depth and concurrency are enforced by definitions, not prompts.

Specialist prompts are context-neutral by default: ordinary Sessions and Loops do not inherit Goal ceremony. Reviewer calls Goal finalization only when an explicit Goal identity and contract are present.

## UI metadata

`AgentDefinition.displayName` is the single display-name source. Runtime exposes the definitions through `GET /api/agents`; the Web uses that catalog for message headers, Agent inspectors, and delegation cards. Task titles remain separate from Agent display names. Unknown IDs are shown neutrally as their raw value and are never relabeled as a known Agent.

## Configuration

The server-wide `~/.archcode/config.json` requires exactly the seven current Agent keys under `agents`. Missing, unknown, or legacy keys fail validation. Display names are not configurable there; they belong to the definitions and catalog.
