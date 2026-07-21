# Multi-Agent Architecture

ArchCode has five closed Agent identities. Agent identity owns tools, delegation targets, depth, and stable responsibility. Profile owns model selection. Skill owns task-specific guidance. These three axes are independent: neither a Profile nor a Skill can grant tools or widen delegation.

| ID | Profile | Purpose |
|---|---|---|
| `lead` | root default `principal` | Sole user entry and final technical owner. Works directly or coordinates bounded children. |
| `analyst` | `deep` | Source-read-only architecture analysis, planning support, gap analysis, and independent review. |
| `build` | `deep` or `fast` | Source-writing implementation and verification specialist. |
| `explore` | `fast` | Terminal read-only local-code investigation. |
| `librarian` | `fast` | Terminal read-only documentation and external-reference research. |

Visual is a future placeholder only; it has no runtime identity, Profile, route, or UI entry.

## Delegation topology

```text
Lead ─┬─ Analyst ─┬─ Explore
      │           └─ Librarian
      ├─ Build ────── Explore
      ├─ Explore
      └─ Librarian
```

- Lead has maximum depth 3 and may delegate Analyst, Build, Explore, or Librarian.
- Analyst has maximum depth 2 and may delegate Explore or Librarian.
- Build has maximum depth 2 and may delegate Explore.
- Explore and Librarian are terminal.
- A Todo-bound Discussion is a restricted root Lead that may delegate only Explore or Librarian at maximum depth 2.
- Target, Profile, Skill existence, depth, direct-child ownership, and family boundaries are enforced before child creation.

`delegate` accepts only `{ agent_type, profile, title, objective, skills, background }`. A child persists this identity and `resume_session` cannot change its Agent, Profile, Skills, or responsibility. General Session concurrency applies; there is no Build path lease or owned-scope protocol.

## Skills instead of role proliferation

Stable Agent prompts describe identity and authority. Workflow methods live in Skills, including `orchestrate-work`, `plan-work`, `run-goal`, `shape-todo`, `review-work`, and `goal-review`. Analyst can combine analysis and review Skills without creating a new Agent identity for every professional role.

A Plan is an ordinary Markdown file under `.archcode/plans/`, not a service, state machine, Session identity, or Goal dependency.

## Sessions, Todos, and Goals

Every user-facing Session is rooted at Lead. A Todo Discussion keeps its existing product entry but derives a restricted Lead capability surface from the authoritative Todo binding and activates `shape-todo`; Ready starts a new ordinary Lead Session.

`Session.goal` is an optional persistent protocol on a root Lead Session. It starts only from an exact fresh user request with persistent intent or the current resumed `ask_user` confirmation. It is independent of Plan.

Goal completion requires a fresh direct `analyst + deep + goal-review` child bound by Runtime to the current Goal instance and generation. Its first non-empty final-output line must be exactly `VERDICT: APPROVED`; any completed non-approval, later ArchCode-known artifact write, Goal edit, or active child requires a new review Analyst. Analyst reports evidence, Lead requests completion, and Runtime mechanically validates the provenance.

## UI metadata and configuration

`AgentDefinition.displayName` is the display-name source. Runtime exposes the five definitions through `GET /api/agents`; Session and child surfaces also expose immutable Profile and active Skills.

The server-wide `~/.archcode/config.json` requires exactly `profiles.principal`, `profiles.deep`, and `profiles.fast`. A root Lead Session may override its next model selection without changing Agent identity. Missing, unknown, or removed per-Agent configuration fails strict validation.
