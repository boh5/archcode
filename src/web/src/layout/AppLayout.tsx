/**
 * AppLayout — 4-column grid shell for the Specra web UI.
 *
 * Grid structure (from design/web-ui.html):
 *   Columns: 52px | 260px | 1fr | 360px
 *   Rows:    48px | 1fr
 *
 *   Header (row 1) spans columns 2–4.
 *   Project bar (col 1) spans all rows.
 *   Sidebar (col 2, row 2), Chat (col 3, row 2), Detail panel (col 4, row 2).
 *
 * Responsive:
 *   ≤1100px: detail panel hidden, sidebar shrinks to 220px
 *   ≤800px:  project bar + sidebar + detail panel hidden, chat fills viewport
 */

interface AppLayoutProps {
  projectBar: React.ReactNode;
  sidebar: React.ReactNode;
  chat: React.ReactNode;
  detailPanel: React.ReactNode;
  header: React.ReactNode;
}

export function AppLayout({
  projectBar,
  sidebar,
  chat,
  detailPanel,
  header,
}: AppLayoutProps) {
  return (
    <div className="app-layout">
      <div className="app-layout__header">{header}</div>
      <div className="app-layout__project-bar">{projectBar}</div>
      <div className="app-layout__sidebar">{sidebar}</div>
      <div className="app-layout__chat">{chat}</div>
      <div className="app-layout__detail-panel">{detailPanel}</div>
    </div>
  );
}