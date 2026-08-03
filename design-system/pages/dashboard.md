# Global Home Page Overrides

> Read [`../MASTER.md`](../MASTER.md) first. `dashboard.html` is the global Home
> prototype. It is not a Project Dashboard and never appears in the project-level
> `Todos / Automations / Sessions` navigation.

## Purpose

Home answers four cross-project questions:

1. What needs me now?
2. What is currently running?
3. What is ready for review?
4. What recurring work is coming next?

It is a small attention and resumption surface, not another inventory and not an
analytics dashboard.

## Layout

- Keep only the theme-adaptive project rail and global work canvas. Do not render
  a project toolbar, persistent project sidebar, or project-level New Session.
- The ArchCode brand mark represents the current Home destination. Project icons
  open each project's Todos page.
- Main content width is at most 1180px with 40px desktop gutters and 18px narrow
  gutters.
- Pair `Needs you` with `Running` and `Ready to review` with `Upcoming` on wide
  screens. Stack all four sections at narrower widths.
- Sections are flat operational bands with rules, not KPI or Bento cards.

## Section Order

1. Intro: `Home` and `Across all projects`.
2. Needs you.
3. Running.
4. Ready to review.
5. Upcoming.

Do not add greetings, marketing copy, metrics, charts, or a global Todo board.

## Rows

- Use one full-width row per actionable item:
  `state icon → entity/title/project context → time or action state`.
- Every row identifies its project and entity type because Home crosses project
  boundaries.
- Needs-you rows use amber plus the exact actionable state, including
  `Inspection`, `Permission`, `Question`, `Blocked`, `Budget limited`,
  `Failed`, or `Timed out`.
  Running rows use the live orbit plus elapsed time. Review rows say what result
  is awaiting review. Upcoming rows identify the Automation schedule.
- Current-project rows use exact Todo, Automation, or Session deep links. Other
  project rows may remain explicit prototype actions rather than fake deep links.
- Prefer a few decision-worthy rows over exhaustive recent activity. Home must
  never become a second Sessions, Automations, or Todos list.

## Search and Attention

- Project-rail `Search all work` remains the only navigational search and covers
  all registered projects and work entities.
- The rail `Needs you` control is the compact cross-project inbox for pending
  permissions, questions, and manual inspections. Home's `Needs you` section is
  broader and also includes failed Sessions, blocked Goals, and failed runs.
- Home has no local filter because it is a curated decision surface, not an
  inventory.

## Home-Specific Avoidances

- a Project Dashboard destination;
- a persistent Sessions/Automations sidebar;
- New Session or New Todo actions in the Home header;
- repeating every Todo simply because it exists;
- Bento/KPI layouts, velocity charts, usage totals, or decorative sparklines;
- equal visual weight for blocked, running, review-ready, and inactive work.
