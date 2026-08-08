# Multi-Agent Architecture

ArchCode has five execution and collaboration identities plus one dedicated user-facing
Discussion identity. Agent identity owns tools, delegation targets, depth, and
stable responsibility. Profile owns model selection. Skill owns task-specific
guidance. These three axes are independent: neither a Profile nor a Skill can
grant tools or widen delegation.

| ID | Profile | Purpose |
|---|---|---|
| `lead` | root default `principal` | Ordinary user-work entry and final technical owner. Works directly or coordinates bounded children. |
| `discussion` | root default `principal` | Shapes one bound Todo and its optional Plan without implementing product work. |
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

Discussion ─┬─ Explore
            └─ Librarian
```

- Lead has maximum depth 3 and may delegate Analyst, Build, Explore, or Librarian.
- Analyst has maximum depth 2 and may delegate Explore or Librarian.
- Build has maximum depth 2 and may delegate Explore.
- Explore and Librarian are terminal.
- Discussion has maximum depth 2 and may delegate only Explore or Librarian.
- Target, Profile, Skill existence, depth, direct-child ownership, and family boundaries are enforced before child creation.

`delegate` accepts only `{ agent_type, profile, title, objective, skills, background }`. A child persists this identity and `resume_session` cannot change its Agent, Profile, Skills, or responsibility. General Session concurrency applies; there is no Build path lease or owned-scope protocol.

## Skills instead of role proliferation

Stable Agent prompts describe identity and authority. Workflow methods live in Skills, including `orchestrate-work`, `plan-work`, `execute-plan`, `run-goal`, `shape-todo`, `review-work`, and `goal-review`. Analyst can combine analysis and review Skills without creating a new Agent identity for every professional role.

A Skill is a standard local package: required `SKILL.md`; optional
`scripts/`, `references/`, `assets/`, and other contained resources. Its
frontmatter accepts only `name`, `description`, `license`, `compatibility`, and
`metadata`; `description` contains both the method and activation timing.
`skill_list` and Prompt discovery expose metadata only. `skill_read` then loads
the entry and its resource descriptors, and can load exactly one listed text
resource on demand. Project > user > builtin is whole-package precedence; no
entry or resource is merged from a lower source, and reserved lifecycle
builtins remain unshadowable.

The package mechanism changes disclosure and storage only. A Skill cannot add
tools, execute a script automatically, change Profiles or MCP access, widen
workspace scope, change delegation, or grant completion authority. A script,
when applicable, is run only through the Agent's existing Bash permission.

A Plan is an ordinary Markdown file under `.archcode/plans/`, not a service, state machine, Session identity, or Goal dependency.

## Sessions, Todos, and Goals

Every user-facing Session is rooted at Lead or Discussion. A Todo-originated
root carries an immutable `{ todoId, entry }` identity. A `discussion` entry
must use the Discussion identity, activates `shape-todo`, and may update only
that source Todo. A `work` or `automation` entry must use Lead. Todo identity
never propagates to child Sessions.

`Session.goal` is an optional persistent protocol on a root Lead Session. Before creating it, Lead asks with ordinary `ask_user` and interprets the answer semantically. Goal is independent of Plan.

Before Goal completion, Lead creates a fresh direct `analyst + deep + goal-review`, reads its ordinary evidence report, fixes material findings and reviews again, or calls `update_goal({ status: "complete", reason })` when it judges the Goal achieved. Runtime does not parse the report or persist Review provenance; it retains only current active-Goal, active-child, and instance/generation consistency checks.

## UI metadata and configuration

`AgentDefinition.displayName` is the display-name source. Runtime exposes all
six definitions through `GET /api/agents`; Session and child surfaces also
expose immutable Profile and active Skills.

The server-wide `~/.archcode/config.json` requires exactly `profiles.principal`,
`profiles.deep`, and `profiles.fast`. A user-facing root Session may override
its next model selection without changing Agent identity. Missing, unknown, or
removed per-Agent configuration fails strict validation.
