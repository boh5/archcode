/**
 * AppLayout — 4-column grid shell for the Specra web UI.
 *
 * Grid structure:
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
    <div className="grid h-screen overflow-hidden grid-cols-[52px_260px_1fr_360px] grid-rows-[48px_1fr] max-[1100px]:grid-cols-[52px_220px_1fr_0px] max-[800px]:grid-cols-[0_0_1fr_0]">
      <div className="col-start-2 col-end-5 row-start-1 row-end-2">{header}</div>
      <div className="col-start-1 col-end-2 row-start-1 row-end-3 max-[800px]:hidden">{projectBar}</div>
      <div className="col-start-2 col-end-3 row-start-2 row-end-3 max-[800px]:hidden">{sidebar}</div>
      <div className="col-start-3 col-end-4 row-start-2 row-end-3">{chat}</div>
      <div className="col-start-4 col-end-5 row-start-2 row-end-3 max-[1100px]:hidden">{detailPanel}</div>
    </div>
  );
}