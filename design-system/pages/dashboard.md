# Dashboard Page Overrides

> Read [`../MASTER.md`](../MASTER.md) first. This file defines Project Dashboard
> information architecture.

## Purpose

The Dashboard answers four operational questions:

1. What needs me?
2. What is running?
3. Where can I continue?
4. What is coming next?

It is a decision and resumption surface, not an analytics report.

## Layout

- Context Inspector is absent on this page.
- Keep the project rail. The project-scoped Dashboard also keeps project
  navigation; the global Dashboard does not add an empty project sidebar.
- Main content width is at most 1180px.
- Use 46px top, 40px horizontal, and 72px bottom padding on desktop.
- At `≥1001px`, pair Needs attention with Running now in one priority row, then
  pair Continue working with a narrower Upcoming region below it. At narrower
  widths, all four regions stack in that order. These are compositional surface
  bands, not KPI or Bento cards.
- Keep 20px gaps between paired regions and 34px between major rows.
- At `≤760px`, use 16px horizontal padding and reflow row metadata below the
  main copy.

## Section Order

1. Intro: `Dashboard` and the plain-language purpose.
2. Needs attention.
3. Running now.
4. Continue working.
5. Upcoming.

Do not lead with metrics, charts, usage totals, or a greeting hero.

## Rows

- Use full-width rows separated by thin rules inside each region, not a grid of
  KPI cards.
- Row structure:
  `status orbit → title/explanation → time/state + Open`.
- Needs-attention rows use amber field plus a 3px amber inset rule.
- Running rows use lime field plus a 3px lime inset rule.
- Ordinary resumable rows remain neutral and reveal the indigo action.
- Preserve the explanation that tells the user why the item matters now.

## Content Rules

- Prefer a small number of actionable items over exhaustive activity.
- Counts belong in compact section badges.
- Time and running duration use tabular or monospace figures.
- Empty sections should explain that no action is required; never show a blank
  chart or a zero-value KPI tile.

## Dashboard-Specific Avoidances

- Bento or KPI tile layouts;
- velocity, productivity, token, or activity charts without a decision use;
- generic AI recommendations;
- decorative sparklines;
- large marketing hero;
- equal visual weight for attention, running, and inactive work.
