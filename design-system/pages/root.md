# Root Entry Surface Overrides

> Read [`../MASTER.md`](../MASTER.md) first. `/` is a routing and first-project
> entry shell. It is not a Dashboard, operational inbox, or global Home.

## Routing Contract

- When a current or last-opened registered project exists, `/` resolves directly
  to `/projects/:slug/todos` with `All todos` selected. Do not briefly render an
  aggregate page before redirecting.
- When no project is registered, `/` renders the project-registration empty
  state. This is the only non-project root surface.
- Registering the first valid workspace opens that project's `All todos`
  surface. Cancel leaves the empty state unchanged.
- The empty state never fabricates Todos, Runs, Schedules, Needs-you counts, or
  cross-project activity. Search and Needs-you controls are absent because they
  have no valid scope.

## Empty-State Composition

- Keep the global rail and brand identity so the app does not look like Setup or
  a disconnected marketing page. With no current project, the brand mark is not
  a navigation link and no project mark is selected.
- The main canvas contains one concise heading, one explanation, one primary
  `Open project` action, and one quiet local-data reassurance. The rail Add
  Project control opens the same dialog; do not create two different flows.
- Settings and theme remain reachable. Do not expose a disabled Todo navigator,
  an empty Dashboard grid, onboarding carousel, templates, recent-project
  fiction, or sample work.
- `Open project` registers an existing absolute workspace directory. Copy must
  not imply that ArchCode creates, uploads, clones, or modifies that directory.

## Responsive And Accessibility

- The empty composition remains centered in the available canvas with a readable
  maximum width and 20px desktop / 16px narrow gutters.
- Primary action and rail controls retain visible focus and at least 44px coarse
  hit areas. The project dialog owns focus while open and returns focus to the
  exact trigger on Close, Cancel, or backdrop dismissal.
- At narrow widths the rail remains 48px and the content stacks without document
  horizontal overflow. The empty state does not introduce a Todo-navigation
  drawer because no Todo scope exists.
