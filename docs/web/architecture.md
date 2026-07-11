# Web UI Architecture

ArchCode runs as a headless server with a browser-based Web UI. The system is organized into five layers that keep startup, runtime orchestration, HTTP/SSE transport, and frontend state management separated while sharing the same project-scoped session model.

## 1. CLI Layer (`src/main.ts`)

The CLI layer is the headless entry point. It creates the `AgentRuntime`, loads configuration, registers providers, tools, and MCP servers, then boots the Hono server. There is no terminal UI in this layer; all user interaction flows through the server and Web UI.

Responsibilities:

- Load and validate `.archcode.json`.
- Initialize provider and model configuration.
- Register builtin tools, memory tools, LSP tools, and MCP tools.
- Create project services and call `bootServer()`.

## 2. Runtime Layer (`src/core/`, `src/agents/`, `src/tools/`, `src/store/`)

The runtime layer owns agent execution, delegation, tool execution, and session state. `AgentRuntime` wires shared services and reconstructs each Agent from the Session's persisted `agentName`.

Responsibilities:

- Create and cache Session-scoped agents with persisted identities.
- Run the query loop and delegation workflow.
- Execute tools through guards, hooks, partitioning, and audit/truncation/redaction after-hooks.
- Persist and project session state through the store.
- Maintain isomorphic stream event reduction via `src/store/reduce.ts`.

## 3. Server Layer (`src/server/`)

The server layer exposes Hono REST and SSE endpoints. It handles request logging, CORS, optional Basic auth, lifecycle events, project routing, and centralized error responses.

Responsibilities:

- Serve health, agent catalog, project, session, message, event, Goal, Loop, HITL, command, and file routes.
- Scope API requests to registered projects.
- Manage server startup and graceful shutdown.
- Coordinate permission and question workflows across network boundaries.
- Serve production Web UI assets from the same server process.

## 4. Transport Layer (SSE + REST)

The transport layer separates real-time streaming from CRUD-style operations. SSE carries live session updates to the Web UI, while REST endpoints handle project registration, file access, message submission, approvals, questions, and workflow operations.

Responsibilities:

- Stream multiplexed Session and resource events through the global SSE connection.
- Recover authoritative state with REST snapshots after reconnect or lag notifications.
- Keep connections alive with heartbeat events.
- Use REST for durable commands and state-changing actions.
- Use durable HITL records for cross-network permissions and questions.

## 5. Web Layer (`src/web/`)

The Web layer is a React application built with Vite and Tailwind. It consumes project-scoped REST endpoints and the session SSE stream to render live agent activity, tool calls, todos, permissions, and questions.

Responsibilities:

- Render the browser UI with React.
- Build and serve development assets through Vite.
- Use a client store for UI/session state.
- Use TanStack Query for REST-backed data fetching and mutations.
- Use an SSE hook for real-time stream updates.
- Apply the shared reducer semantics from `src/store/reduce.ts` where session events need consistent interpretation.

## Data Flow

```text
.archcode.json → config → providers → tools → MCP → bootServer() → Hono → project-scoped Agent → query loop → store → SSE → Web UI
```

## Key Design Decisions

### Single server, multi-project model

ArchCode runs one server process that can manage multiple registered workspace roots. The project registry stores known projects, derives stable slugs, and routes API calls through project-scoped contexts. Each workspace gets its own runtime context. Ordinary root Sessions persist `engineer`; Goal execution creates a dedicated root Session that persists `goal_lead`.

### Global SSE plus authoritative snapshots

One global SSE connection carries live Session, Goal, Loop, HITL, resource, and runtime changes. REST snapshots remain authoritative; reconnect and lag handling refresh affected queries instead of inventing client-side state.

### Durable HITL for permissions and questions

Permission and question prompts cross the server/browser boundary as durable owner-scoped HITL records. The Web UI renders only redacted display payloads and submits responses through REST; continuation resumes from the persisted checkpoint.

### Isomorphic reducer shared by server and web

`src/store/reduce.ts` defines the stream event reducer used to convert raw events into session state. Keeping reducer semantics shared prevents server and Web UI views from drifting when events such as text deltas, reasoning deltas, tool calls, todos, reminders, and lifecycle transitions evolve.
